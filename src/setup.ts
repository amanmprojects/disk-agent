/**
 * One-command interactive setup:
 *   home layout → config (Telegram, model, …) → Pi CLI →
 *   Pi extensions (pi-web-search, pi-agent-browser-native) →
 *   agent-browser CLI + Chrome → OpenCode Go login
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { resolveWebSearchExtension } from "./agent/pi.js";
import { hasAnyAuth, loginProvider } from "./auth/login.js";
import { type AppConfig, bootstrapHome, loadConfig, saveConfig } from "./config.js";
import {
  type DiskAgentPaths,
  describeLayout,
  ensureLayout,
  getPaths,
  piAuthPath,
  piSettingsPath,
  resolvePiAgentDir,
} from "./paths.js";
import type { StepResult } from "./setup/install-steps.js";
import { collectPiModels, readPiAuthProviders, readPiDefault } from "./setup/pi-import.js";
import { canUseOpentui, type InstallPhaseStep, runTuiSetup, type TuiValues } from "./setup/tui.js";
import { getVersion } from "./version.js";

const require = createRequire(import.meta.url);

/**
 * Default Pi packages installed during setup.
 * - pi-web-search: provider-native web_search + url_context (no API key needed)
 * - pi-agent-browser-native: exposes agent-browser as a native Pi tool
 */
export const DEFAULT_PI_PACKAGES = ["npm:pi-web-search", "npm:pi-agent-browser-native"] as const;

/** Docs: https://agent-browser.dev/ */
export const AGENT_BROWSER_DOCS = "https://agent-browser.dev/";

export interface SetupOptions {
  agentName?: string;
  dataDir?: string;
  workspaceDir?: string;
  model?: string;
  telegramToken?: string;
  ownerId?: string;
  /** Skip ensuring pi CLI / packages */
  skipPi?: boolean;
  /** Skip agent-browser CLI + Chrome download */
  skipBrowser?: boolean;
  /** Skip login prompt */
  skipLogin?: boolean;
  /** Force login even if already authenticated */
  forceLogin?: boolean;
  /** Auth provider for the login step (with --yes or to skip the choice prompt) */
  loginProvider?: "opencode-go";
  /** Non-interactive: no prompts; skip optional login/browser confirm unless forced */
  yes?: boolean;
  /** Explicitly request login (with --yes) */
  login?: boolean;
  /** Extra pi packages to install (npm:… specs) */
  packages?: string[];
  cwd?: string;
  /** TUI wizard: true=force, false=classic prompts (--no-tui), undefined=auto */
  tui?: boolean;
}

export interface SetupResult {
  cfg: AppConfig;
  paths: DiskAgentPaths;
  pi: {
    binary: string | null;
    installed: boolean;
    packages: string[];
    agentDir: string;
  };
  browser: {
    cli: string | null;
    installed: boolean;
    chromeOk: boolean;
    detail: string;
  };
  telegram: { configured: boolean };
  webSearchExtension: string | null;
  auth: { attempted: boolean; ok: boolean; detail: string };
  version: string;
}

function step(n: number, total: number, msg: string): void {
  console.log(`${chalk.bold(`\n[${n}/${total}]`)} ${msg}`);
}

function ok(msg: string): void {
  console.log(chalk.green("  ✓ ") + msg);
}

function warn(msg: string): void {
  console.log(chalk.yellow("  ⚠ ") + msg);
}

function fail(msg: string): void {
  console.log(chalk.red("  ✗ ") + msg);
}

function isInteractive(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!isInteractive()) return defaultYes;
  const rl = createInterface({ input, output });
  try {
    const hint = defaultYes ? "Y/n" : "y/N";
    const ans = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (!ans) return defaultYes;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

async function ask(
  question: string,
  opts?: { defaultValue?: string; secret?: boolean },
): Promise<string> {
  if (!isInteractive()) return opts?.defaultValue ?? "";
  const rl = createInterface({ input, output });
  try {
    const suffix = opts?.defaultValue ? chalk.dim(` [${opts.defaultValue}]`) : "";
    const hint = opts?.secret ? chalk.dim(" (input may be visible)") : "";
    const ans = (await rl.question(`${question}${suffix}${hint}: `)).trim();
    return ans || opts?.defaultValue || "";
  } finally {
    rl.close();
  }
}

function whichCmd(cmd: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return line && existsSync(line) ? line : null;
}

/** Resolve the pi CLI binary path (PATH, then dependency). */
export function resolvePiBinary(): string | null {
  const onPath = whichCmd("pi");
  if (onPath) return onPath;

  try {
    const pkgJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const cli = join(dirname(pkgJson), "dist", "cli.js");
    if (existsSync(cli)) return cli;
  } catch {
    /* not found */
  }

  for (const pkgName of ["@amanm/disk-agent", "disk-agent"]) {
    try {
      const here = dirname(require.resolve(`${pkgName}/package.json`));
      const nested = join(
        here,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      if (existsSync(nested)) return nested;
    } catch {
      /* try next name */
    }
  }

  return null;
}

function runNode(
  script: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: opts?.cwd,
    env: process.env,
    timeout: opts?.timeoutMs ?? 300_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

function runCmd(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: process.env,
    timeout: opts?.timeoutMs ?? 300_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

/**
 * Ensure the pi CLI is available. Installs @earendil-works/pi-coding-agent globally if missing.
 */
export async function ensurePi(opts?: { skipGlobalInstall?: boolean }): Promise<{
  binary: string | null;
  installed: boolean;
  detail: string;
  exitCode?: number | null;
}> {
  let binary = resolvePiBinary();
  if (binary) {
    return { binary, installed: true, detail: `found ${binary}` };
  }

  if (opts?.skipGlobalInstall) {
    return { binary: null, installed: false, detail: "pi not found (skipped install)" };
  }

  const npm = runCmd("npm", ["install", "-g", "@earendil-works/pi-coding-agent"]);
  if (!npm.ok) {
    binary = resolvePiBinary();
    if (binary) {
      return {
        binary,
        installed: true,
        detail: `using bundled pi at ${binary} (global install failed: ${npm.stderr.trim() || npm.stdout.trim()})`,
      };
    }
    return {
      binary: null,
      installed: false,
      detail: `failed to install pi: ${npm.stderr.trim() || npm.stdout.trim() || "unknown error"}`,
      exitCode: npm.code,
    };
  }

  binary = resolvePiBinary();
  if (binary) {
    return { binary, installed: true, detail: `installed globally → ${binary}` };
  }
  return { binary: null, installed: false, detail: "pi installed but binary not found on PATH" };
}

function readPiSettings(agentDir: string): { packages?: string[]; [k: string]: unknown } {
  const path = piSettingsPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { packages?: string[] };
  } catch {
    return {};
  }
}

function writePiSettings(agentDir: string, data: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(piSettingsPath(agentDir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Package name without npm: prefix or version (handles scoped @org/name). */
function npmPackageName(spec: string): string {
  const raw = spec.replace(/^npm:/, "");
  if (raw.startsWith("@")) {
    // @scope/name or @scope/name@version
    const m = raw.match(/^(@[^/]+\/[^@]+)/);
    return m?.[1] ?? raw;
  }
  return raw.split("@")[0] ?? raw;
}

function packageListed(packages: string[] | undefined, spec: string): boolean {
  if (!packages?.length) return false;
  const name = npmPackageName(spec);
  return packages.some((p) => {
    const s = typeof p === "string" ? p : String((p as { source?: string }).source ?? p);
    return s === spec || s.includes(name);
  });
}

/**
 * Install pi packages (extensions) via `pi install`, with settings.json fallback.
 */
export function ensurePiPackages(
  piBinary: string | null,
  packages: string[],
  opts?: { quiet?: boolean },
): { installed: string[]; failed: Array<{ pkg: string; error: string; code?: number | null }> } {
  const agentDir = resolvePiAgentDir();
  mkdirSync(agentDir, { recursive: true });

  const installed: string[] = [];
  const failed: Array<{ pkg: string; error: string; code?: number | null }> = [];
  const settings = readPiSettings(agentDir);
  const current = Array.isArray(settings.packages) ? [...settings.packages] : [];

  for (const pkg of packages) {
    if (packageListed(current, pkg)) {
      if (!opts?.quiet) ok(`${pkg} already in pi settings`);
      installed.push(pkg);
      continue;
    }

    if (piBinary) {
      const isJs = piBinary.endsWith(".js");
      const result = isJs
        ? runNode(piBinary, ["install", pkg])
        : runCmd(piBinary, ["install", pkg]);

      if (result.ok) {
        installed.push(pkg);
        if (!opts?.quiet) ok(`installed ${pkg}`);
        // refresh settings view
        const refreshed = readPiSettings(agentDir);
        if (Array.isArray(refreshed.packages)) {
          current.splice(0, current.length, ...refreshed.packages);
        } else if (!packageListed(current, pkg)) {
          current.push(pkg);
        }
        continue;
      }

      if (!opts?.quiet) {
        warn(
          `pi install failed for ${pkg}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
        );
      }
    }

    // Manual settings registration + ensure npm package under pi agent npm tree
    if (!packageListed(current, pkg)) current.push(pkg);
    settings.packages = current;
    writePiSettings(agentDir, settings);

    const npmName = pkg.replace(/^npm:/, "");
    const npmInstall = runCmd("npm", [
      "install",
      npmName,
      "--prefix",
      join(agentDir, "npm"),
      "--omit=dev",
    ]);
    if (npmInstall.ok) {
      installed.push(pkg);
      if (!opts?.quiet) ok(`registered ${pkg} in ${piSettingsPath(agentDir)}`);
    } else {
      failed.push({
        pkg,
        error: npmInstall.stderr.trim() || npmInstall.stdout.trim() || "install failed",
        code: npmInstall.code,
      });
    }
  }

  return { installed, failed };
}

/**
 * Install agent-browser CLI globally and download Chrome (first-time).
 * Docs: https://agent-browser.dev/
 */
export async function ensureAgentBrowser(opts?: {
  skipChrome?: boolean;
  quiet?: boolean;
}): Promise<{
  cli: string | null;
  installed: boolean;
  chromeOk: boolean;
  detail: string;
  exitCode?: number | null;
}> {
  let cli = whichCmd("agent-browser");

  if (!cli) {
    const npm = runCmd("npm", ["install", "-g", "agent-browser"]);
    if (!npm.ok) {
      return {
        cli: null,
        installed: false,
        chromeOk: false,
        detail: `npm install -g agent-browser failed: ${npm.stderr.trim() || npm.stdout.trim() || "unknown"}`,
        exitCode: npm.code,
      };
    }
    cli = whichCmd("agent-browser");
    if (!cli) {
      return {
        cli: null,
        installed: false,
        chromeOk: false,
        detail: "agent-browser installed but binary not found on PATH",
      };
    }
    if (!opts?.quiet) ok(`agent-browser installed → ${cli}`);
  } else {
    if (!opts?.quiet) ok(`agent-browser found → ${cli}`);
  }

  if (opts?.skipChrome) {
    return {
      cli,
      installed: true,
      chromeOk: false,
      detail: "CLI present; Chrome install skipped",
    };
  }

  // Download Chrome / browser backend for first-time use
  const install = runCmd(cli, ["install"], { timeoutMs: 600_000 });
  if (install.ok) {
    if (!opts?.quiet) ok("browser backend ready (Chrome)");
    return {
      cli,
      installed: true,
      chromeOk: true,
      detail: "CLI + Chrome ready",
    };
  }

  // Some versions already have Chrome — treat non-zero with existing CLI as soft fail
  if (!opts?.quiet) {
    warn(
      `agent-browser install: ${(install.stderr || install.stdout).trim().slice(0, 200) || "non-zero exit"}`,
    );
  }
  return {
    cli,
    installed: true,
    chromeOk: false,
    detail: "CLI installed; Chrome download may need: agent-browser install",
    exitCode: install.code,
  };
}

function applyModel(cfg: AppConfig, model: string): void {
  const raw = model.trim();
  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    if (provider && rest.length) {
      cfg.model.provider = provider;
      cfg.model.id = rest.join("/");
    }
  } else if (raw) {
    cfg.model.id = raw;
  }
}

function upsertEnv(envPath: string, entries: Record<string, string | undefined>): void {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === "") continue;
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (re.test(text)) {
      text = text.replace(re, line);
    } else {
      if (text && !text.endsWith("\n")) text += "\n";
      text += `${line}\n`;
    }
  }
  writeFileSync(envPath, text, "utf8");
}

function readEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, "utf8");
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return undefined;
  const v = m[1]!.trim().replace(/^["']|["']$/g, "");
  return v || undefined;
}

function maskSecret(value: string): string {
  if (value.length > 12) return `${value.slice(0, 8)}…${value.slice(-4)}`;
  if (value.length > 4) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return "********";
}

/** Map wizard values onto SetupOptions (non-interactive: user already chose). */
function tuiValuesToOptions(v: TuiValues): SetupOptions {
  return {
    agentName: v.agentName,
    model: v.model,
    cwd: v.cwd,
    telegramToken: v.telegramToken,
    ownerId: v.ownerId,
    skipPi: v.skipPi,
    skipBrowser: v.skipBrowser,
    skipLogin: v.skipLogin,
    loginProvider: v.loginProvider,
    login: v.loginProvider ? true : undefined,
    yes: true,
  };
}

function cancelledResult(version: string, paths: DiskAgentPaths): SetupResult {
  const agentDir = resolvePiAgentDir();
  return {
    cfg: loadConfig({ dataDir: paths.home, workspaceDir: paths.workspace }),
    paths,
    pi: { binary: null, installed: false, packages: [], agentDir },
    browser: { cli: null, installed: false, chromeOk: false, detail: "cancelled" },
    telegram: { configured: false },
    webSearchExtension: null,
    auth: { attempted: false, ok: false, detail: "cancelled" },
    version,
  };
}

/**
 * Existing values for prefill, with the same precedence as the classic
 * prompts: explicit opts → env → saved config → defaults.
 */
function resolveExistingValues(
  cfg: AppConfig,
  paths: DiskAgentPaths,
  opts: SetupOptions,
): {
  agentName: string;
  model: string;
  cwd: string;
  telegramToken?: string;
  ownerId?: string;
} {
  // Prefill the model from Pi's configured default when nothing is set yet
  // and the config still has the stock opencode-go/grok-4.5 default.
  const cfgDefault = `${cfg.model.provider}/${cfg.model.id}`;
  let model = opts.model || process.env.DISK_AGENT_MODEL || cfgDefault;
  if (!opts.model && !process.env.DISK_AGENT_MODEL && cfgDefault === "opencode-go/grok-4.5") {
    const pi = readPiDefault(piSettingsPath());
    if (pi.provider && pi.model) model = `${pi.provider}/${pi.model}`;
  }

  return {
    agentName: opts.agentName || cfg.agentName || "Disk",
    model,
    cwd: opts.cwd || process.env.DISK_AGENT_CWD || cfg.cwd,
    telegramToken:
      opts.telegramToken ||
      cfg.telegram.botToken ||
      process.env.TELEGRAM_BOT_TOKEN ||
      readEnvValue(paths.envFile, "TELEGRAM_BOT_TOKEN"),
    ownerId:
      opts.ownerId ||
      cfg.telegram.ownerId ||
      process.env.DISK_AGENT_OWNER_ID ||
      readEnvValue(paths.envFile, "DISK_AGENT_OWNER_ID"),
  };
}

export interface CollectedUserConfig {
  agentName: string;
  model?: string;
  telegramToken?: string;
  ownerId?: string;
  cwd?: string;
}

/** Apply collected user config to cfg + env (no output). */
function applyUserConfig(cfg: AppConfig, paths: DiskAgentPaths, user: CollectedUserConfig): void {
  cfg.agentName = user.agentName;
  if (user.model) applyModel(cfg, user.model);
  if (user.cwd) cfg.cwd = user.cwd;
  if (user.telegramToken) {
    cfg.telegram.botToken = user.telegramToken;
    cfg.telegram.enabled = true;
  }
  if (user.ownerId) cfg.telegram.ownerId = String(user.ownerId);

  saveConfig(cfg);
  upsertEnv(paths.envFile, {
    TELEGRAM_BOT_TOKEN: user.telegramToken,
    DISK_AGENT_OWNER_ID: user.ownerId,
    DISK_AGENT_MODEL: user.model || `${cfg.model.provider}/${cfg.model.id}`,
    DISK_AGENT_CWD: user.cwd,
  });
}

/**
 * Interactive prompts for agent name, model, Telegram, owner, cwd.
 * Flags / existing env take precedence; --yes skips prompts (keeps defaults / flags).
 */
async function collectUserConfig(
  cfg: AppConfig,
  paths: DiskAgentPaths,
  opts: SetupOptions,
): Promise<CollectedUserConfig> {
  const existing = resolveExistingValues(cfg, paths, opts);
  const {
    agentName: existingName,
    model: existingModel,
    cwd: existingCwd,
    telegramToken: existingToken,
    ownerId: existingOwner,
  } = existing;

  if (opts.yes || !isInteractive()) {
    return {
      agentName: existingName,
      model: opts.model || existingModel,
      telegramToken: existingToken,
      ownerId: existingOwner,
      cwd: opts.cwd || existingCwd,
    };
  }

  console.log(chalk.bold("\n  Configure your agent"));
  console.log(
    chalk.dim(
      "  Press Enter to keep the value in [brackets]. Leave optional fields blank to configure later.\n",
    ),
  );

  const agentName = await ask("Agent name", { defaultValue: existingName });
  const model = await ask("Default model (provider/id)", {
    defaultValue: existingModel,
  });
  const cwd = await ask("Coding tools working directory (cwd)", {
    defaultValue: existingCwd,
  });

  console.log("");
  console.log(chalk.dim("  Telegram (optional — from @BotFather: https://t.me/BotFather)"));
  let telegramToken = existingToken;
  if (existingToken) {
    ok(`telegram:  existing token detected (${maskSecret(existingToken)})`);
    if (await confirm("Replace Telegram bot token?", false)) {
      telegramToken = await ask("TELEGRAM_BOT_TOKEN", { secret: true });
    }
  } else {
    telegramToken = await ask("TELEGRAM_BOT_TOKEN (leave empty to skip)", {
      secret: true,
    });
  }

  let ownerId = existingOwner;
  if (telegramToken) {
    ownerId = await ask("Your Telegram user id (owner, optional)", {
      defaultValue: existingOwner,
    });
  }

  return {
    agentName: agentName || "Disk",
    model: model || existingModel,
    telegramToken: telegramToken || undefined,
    ownerId: ownerId || undefined,
    cwd: cwd || existingCwd,
  };
}

function okResult(detail: string): StepResult {
  return { ok: true, detail };
}

function failResult(
  detail: string,
  opts?: { exitCode?: number | null; stderrTail?: string },
): StepResult {
  return { ok: false, detail, exitCode: opts?.exitCode, stderrTail: opts?.stderrTail };
}

/** Structured values the in-wizard install steps write back for SetupResult. */
interface InstallCtx {
  piBinary: string | null;
  piInstalled: boolean;
  packagesInstalled: string[];
  browser: SetupResult["browser"];
  authAttempted: boolean;
  authOk: boolean;
  authDetail: string;
  webSearchExt: string | null;
}

function createInstallCtx(): InstallCtx {
  return {
    piBinary: null,
    piInstalled: false,
    packagesInstalled: [],
    browser: { cli: null, installed: false, chromeOk: false, detail: "not run" },
    authAttempted: false,
    authOk: false,
    authDetail: "",
    webSearchExt: null,
  };
}

/** Wizard install steps for steps 3–6; run inside the TUI after "Review & run". */
function buildInstallSteps(opts: SetupOptions, ctx: InstallCtx): InstallPhaseStep[] {
  const wanted = [...new Set([...(opts.packages ?? DEFAULT_PI_PACKAGES)])];
  return [
    {
      id: "pi",
      title: "Install Pi coding-agent CLI",
      skipWhen: (v) => v.skipPi,
      build: () => async () => {
        const r = await ensurePi();
        ctx.piBinary = r.binary;
        ctx.piInstalled = r.installed;
        return r.installed
          ? okResult(r.detail)
          : failResult(r.detail, { exitCode: r.exitCode ?? null, stderrTail: r.detail });
      },
    },
    {
      id: "extensions",
      title: "Install Pi extensions (pi-web-search, …)",
      skipWhen: (v) => v.skipPi,
      build: () => async () => {
        const result = ensurePiPackages(ctx.piBinary, wanted, { quiet: true });
        ctx.packagesInstalled = result.installed;
        ctx.webSearchExt = resolveWebSearchExtension();
        if (result.failed.length) {
          const first = result.failed[0];
          return failResult(result.failed.map((f) => `${f.pkg}: ${f.error}`).join("\n"), {
            exitCode: first?.code ?? null,
            stderrTail: result.failed.map((f) => f.error).join("\n"),
          });
        }
        return okResult(
          result.installed.length
            ? `installed: ${result.installed.join(", ")}`
            : "already installed",
        );
      },
    },
    {
      id: "browser",
      title: "Install agent-browser + Chrome",
      skipWhen: (v) => v.skipBrowser,
      build: () => async () => {
        const r = await ensureAgentBrowser({ quiet: true });
        ctx.browser = {
          cli: r.cli,
          installed: r.installed,
          chromeOk: r.chromeOk,
          detail: r.detail,
        };
        return r.installed
          ? okResult(r.detail)
          : failResult(r.detail, { exitCode: r.exitCode ?? null, stderrTail: r.detail });
      },
    },
    {
      id: "auth",
      title: "Authenticate (OpenCode Go API key)",
      suspendForRun: true,
      skipWhen: (v) => v.skipLogin,
      build: () => async () => {
        const already = await hasAnyAuth();
        if (already && !opts.forceLogin) {
          ctx.authAttempted = false;
          ctx.authOk = true;
          ctx.authDetail = "credentials already present";
          return okResult("credentials already present");
        }
        ctx.authAttempted = true;
        const result = await loginProvider("opencode-go", {
          type: "api_key",
          force: opts.forceLogin,
        });
        ctx.authOk = result.ok;
        ctx.authDetail = result.ok ? "logged in as opencode-go" : result.error;
        if (result.ok) return okResult("logged in as opencode-go");
        return failResult(
          `${result.error}\nRetry later: disk-agent login opencode-go --type api_key`,
          { stderrTail: result.error },
        );
      },
    },
  ];
}

/** SetupResult from in-wizard install results (TUI mode). */
function setupResultFromCtx(
  version: string,
  paths: DiskAgentPaths,
  ctx: InstallCtx,
  opts: { aborted?: boolean },
): SetupResult {
  const agentDir = resolvePiAgentDir();
  const finalCfg = loadConfig({ dataDir: paths.home, workspaceDir: paths.workspace });
  return {
    cfg: finalCfg,
    paths,
    pi: {
      binary: ctx.piBinary,
      installed: ctx.piInstalled,
      packages: ctx.packagesInstalled,
      agentDir,
    },
    browser: ctx.browser,
    telegram: {
      configured: Boolean(
        finalCfg.telegram.botToken ||
          process.env.TELEGRAM_BOT_TOKEN ||
          readEnvValue(paths.envFile, "TELEGRAM_BOT_TOKEN"),
      ),
    },
    webSearchExtension: ctx.webSearchExt,
    auth: {
      attempted: ctx.authAttempted,
      ok: ctx.authOk,
      detail: opts.aborted ? "aborted" : ctx.authDetail,
    },
    version,
  };
}

/**
 * Full first-run setup. Idempotent — safe to re-run.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const version = getVersion();

  // Layout + home bootstrap happen before any output so the OpenTUI wizard
  // (alternate screen) starts clean; step 1 below prints the same result.
  const paths = getPaths({ home: opts.dataDir, workspace: opts.workspaceDir });
  ensureLayout(paths);
  const bootstrapCfg = bootstrapHome({
    dataDir: paths.home,
    workspaceDir: paths.workspace,
    agentName: opts.agentName ?? "Disk",
  });

  // ── TUI wizard (--tui forces it; --no-tui / --yes keep the classic flow) ──
  // Auto mode engages when interactive. Forced mode skips the TTY check so
  // pty-driven scripting / CI screenshots can request the wizard explicitly.
  // Set when the wizard ran the install phase inside the TUI (steps 3–6 done).
  let tuiInstallsRan = false;
  let installCtx: InstallCtx | null = null;

  const wantTui = opts.tui === true || (opts.tui !== false && !opts.yes && isInteractive());
  if (wantTui) {
    if (!canUseOpentui()) {
      // OpenTUI needs Bun or Node >= 26.4 + --experimental-ffi. If bun is on
      // PATH, re-exec this same command under it and inherit the terminal.
      const bun = whichCmd("bun");
      if (bun) {
        const r = spawnSync(bun, process.argv.slice(1), {
          stdio: "inherit",
          env: process.env,
          timeout: 600_000,
        });
        // Fall back to classic prompts if bun itself failed to start.
        if (!r.error && r.status !== null) process.exit(r.status ?? 1);
      }
      // no bun (or bun failed) → fall through to the classic readline prompts below
    } else {
      const piInfo = await collectPiModels();
      const existing = resolveExistingValues(bootstrapCfg, paths, opts);
      const auth = {
        providers: readPiAuthProviders(piAuthPath()),
        envKeys: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((k) =>
          Boolean(process.env[k]?.trim()),
        ),
      };
      installCtx = createInstallCtx();
      const outcome = await runTuiSetup(
        { version, existing, piInfo, auth },
        { steps: buildInstallSteps(opts, installCtx) },
      );
      if (outcome.cancelled && !outcome.rendererFailed) {
        console.log(chalk.yellow("\n  Setup cancelled — nothing changed."));
        return cancelledResult(version, paths);
      }
      if (!outcome.rendererFailed && outcome.values) {
        opts = { ...opts, ...tuiValuesToOptions(outcome.values) };
      }
      if (outcome.install) {
        tuiInstallsRan = true;
        if (outcome.install.aborted) {
          console.log(
            chalk.yellow("\n  Setup cancelled — installs aborted (partial changes may remain)."),
          );
          return setupResultFromCtx(version, paths, installCtx, { aborted: true });
        }
      }
      // rendererFailed → fall through to classic prompts
    }
  }

  const total = 7;
  if (!tuiInstallsRan) {
    console.log(chalk.bold.cyan(`\nDisk Agent v${version} — setup\n`));
    console.log(
      chalk.dim(
        "This wizard installs Pi, pi-web-search, agent-browser, and configures home + Telegram.\n" +
          "Auth: OpenCode Go subscription (API key, opencode.ai) or your own provider keys.\n",
      ),
    );
  }

  // ── 1. Home layout ──────────────────────────────────────────────────────
  if (!tuiInstallsRan) step(1, total, "Initialize standardized home directory");
  const cfg = bootstrapHome({
    dataDir: paths.home,
    workspaceDir: paths.workspace,
    agentName: opts.agentName ?? "Disk",
  });
  if (!tuiInstallsRan) {
    ok(`home:      ${paths.home}`);
    ok(`workspace: ${paths.workspace}`);
    ok(`config:    ${paths.configFile}`);
    ok(`skills:    ${paths.workspaceSkills} (workspace), ${paths.userSkills} (user)`);
    ok(
      "layout:\n" +
        describeLayout(paths)
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n"),
    );
  }

  // ── 2. Interactive config (Telegram, model, …) ──────────────────────────
  if (!tuiInstallsRan) step(2, total, "Agent, Telegram & model configuration");
  const user = await collectUserConfig(cfg, paths, opts);
  applyUserConfig(cfg, paths, user);

  if (!tuiInstallsRan) {
    ok(`agent:     ${cfg.agentName}`);
    ok(`model:     ${cfg.model.provider}/${cfg.model.id}`);
    ok(`cwd:       ${cfg.cwd}`);
    if (user.telegramToken) {
      ok(`telegram:  enabled (token saved to ${paths.envFile})`);
      if (user.ownerId) ok(`owner:     ${user.ownerId}`);
    } else {
      warn(`telegram:  not configured — add TELEGRAM_BOT_TOKEN to ${paths.envFile}`);
    }
  }

  // ── 3–6. Install steps ─────────────────────────────────────────────────
  // TUI mode: these already ran inside the wizard (results in installCtx).
  let piBinary: string | null = installCtx?.piBinary ?? null;
  let piInstalled = installCtx?.piInstalled ?? false;
  let packagesInstalled: string[] = installCtx?.packagesInstalled ?? [];
  let webSearchExt: string | null = installCtx?.webSearchExt ?? null;
  let browserResult: SetupResult["browser"] = installCtx?.browser ?? {
    cli: whichCmd("agent-browser"),
    installed: Boolean(whichCmd("agent-browser")),
    chromeOk: false,
    detail: "skipped",
  };
  let authAttempted = installCtx?.authAttempted ?? false;
  let authOk = installCtx?.authOk ?? false;
  let authDetail = installCtx?.authDetail ?? "";
  const agentDir = resolvePiAgentDir();

  if (!tuiInstallsRan) {
    // ── 3. Pi CLI ──────────────────────────────────────────────────────
    step(3, total, "Ensure Pi coding-agent CLI");
    if (opts.skipPi) {
      piBinary = resolvePiBinary();
      piInstalled = Boolean(piBinary);
      warn("skipped pi install (--skip-pi)");
    } else {
      const pi = await ensurePi();
      piBinary = pi.binary;
      piInstalled = pi.installed;
      if (pi.installed) ok(pi.detail);
      else fail(pi.detail);
    }
    ok(`pi agent dir: ${agentDir}`);

    // ── 4. Pi extensions ───────────────────────────────────────────────
    step(4, total, "Install Pi extensions (pi-web-search, pi-agent-browser-native, …)");
    const wanted = [...new Set([...(opts.packages ?? DEFAULT_PI_PACKAGES)])];
    if (opts.skipPi) {
      warn("skipped package install");
      packagesInstalled = wanted.filter((p) => packageListed(readPiSettings(agentDir).packages, p));
    } else {
      const result = ensurePiPackages(piBinary, wanted);
      packagesInstalled = result.installed;
      for (const f of result.failed) {
        fail(`${f.pkg}: ${f.error}`);
      }
    }

    webSearchExt = resolveWebSearchExtension();
    if (webSearchExt) ok(`pi-web-search extension: ${webSearchExt}`);
    else warn("pi-web-search extension not resolved — npm i pi-web-search");

    if (packageListed(packagesInstalled, "npm:pi-agent-browser-native")) {
      ok("pi-agent-browser-native registered");
    }
    if (packageListed(packagesInstalled, "npm:pi-web-search")) {
      ok("pi-web-search registered");
    }

    // ── 5. agent-browser CLI + Chrome ──────────────────────────────────
    step(5, total, `Install agent-browser (${AGENT_BROWSER_DOCS})`);
    if (opts.skipBrowser) {
      warn("skipped agent-browser (--skip-browser)");
      browserResult.detail = "skipped (--skip-browser)";
    } else if (opts.yes) {
      browserResult = await ensureAgentBrowser();
      // Success lines already printed by ensureAgentBrowser
      if (!browserResult.installed) fail(browserResult.detail);
    } else {
      const want =
        browserResult.installed ||
        (await confirm("Install agent-browser for full browser automation? (recommended)", true));
      if (want) {
        browserResult = await ensureAgentBrowser();
        // Success lines already printed by ensureAgentBrowser
        if (!browserResult.installed) fail(browserResult.detail);
      } else {
        warn("skipped agent-browser — web_get will use plain fetch only");
        browserResult.detail = "skipped by user";
      }
    }

    // ── 6. Auth ────────────────────────────────────────────────────────
    step(6, total, "Authenticate (OpenCode Go API key)");
    const already = await hasAnyAuth();

    /** Run OpenCode Go API-key login; updates authOk/authDetail. */
    const loginOpenCodeGo = async (force: boolean): Promise<void> => {
      authAttempted = true;
      const result = await loginProvider("opencode-go", { type: "api_key", force });
      authOk = result.ok;
      authDetail = result.ok ? "logged in as opencode-go" : result.error;
      if (result.ok) ok(authDetail);
      else {
        fail(authDetail);
        console.log(
          chalk.dim("    You can retry later: disk-agent login opencode-go --type api_key"),
        );
        console.log(chalk.dim(`    Or set OPENCODE_API_KEY in ${paths.envFile}`));
      }
    };

    if (opts.skipLogin) {
      authDetail = "skipped (--skip-login)";
      warn(authDetail);
    } else if (already && !opts.forceLogin) {
      authOk = true;
      authDetail = "credentials already present";
      ok(authDetail);
      // Already authenticated — still offer to add OpenCode Go (API key)
      const wantOpenCode =
        opts.loginProvider === "opencode-go" ||
        (opts.loginProvider === undefined &&
          !opts.yes &&
          (await confirm("Add OpenCode Go subscription (API key) too?", false)));
      if (wantOpenCode) await loginOpenCodeGo(false);
    } else {
      // Pick provider: opencode-go (API key) | none
      let provider: "opencode-go" | null = null;
      if (opts.loginProvider) {
        provider = opts.loginProvider;
      } else if (opts.login || opts.forceLogin) {
        provider = "opencode-go"; // --login / --force-login default to OpenCode Go
      } else if (!opts.yes) {
        console.log("");
        console.log(chalk.dim("  Auth options:"));
        console.log(chalk.dim("    opencode-go — OpenCode Go subscription (API key, opencode.ai)"));
        const choice = (
          await ask("Authenticate with (opencode-go, blank to skip)", {
            defaultValue: "opencode-go",
          })
        )
          .trim()
          .toLowerCase();
        provider =
          choice === "opencode" || choice === "opencode-go" || choice === "og"
            ? "opencode-go"
            : null;
      }

      const shouldLogin =
        opts.login === true ||
        opts.forceLogin === true ||
        (provider !== null &&
          !opts.yes &&
          (await confirm("Configure OpenCode Go API key now?", true)));

      if (provider && shouldLogin) {
        await loginOpenCodeGo(Boolean(opts.forceLogin));
      } else if (!provider) {
        authDetail = "deferred — run disk-agent login when ready";
        warn(authDetail);
        if (process.env.OPENCODE_API_KEY || readEnvValue(paths.envFile, "OPENCODE_API_KEY")) {
          authOk = true;
          ok("OPENCODE_API_KEY present (opencode / opencode-go)");
        }
        if (process.env.ANTHROPIC_API_KEY || readEnvValue(paths.envFile, "ANTHROPIC_API_KEY")) {
          authOk = true;
          ok("ANTHROPIC_API_KEY present");
        }
        if (process.env.OPENAI_API_KEY || readEnvValue(paths.envFile, "OPENAI_API_KEY")) {
          authOk = true;
          ok("OPENAI_API_KEY present");
        }
      } else {
        authDetail = "deferred — run disk-agent login when ready";
        warn(authDetail);
      }
    }
  }

  // ── 7. Summary ──────────────────────────────────────────────────────────
  step(7, total, "Done");
  const telegramConfigured = Boolean(
    cfg.telegram.botToken ||
      process.env.TELEGRAM_BOT_TOKEN ||
      readEnvValue(paths.envFile, "TELEGRAM_BOT_TOKEN"),
  );

  console.log("");
  console.log(chalk.green.bold("✓ Disk Agent is ready"));
  console.log(`  version:   ${version}`);
  console.log(`  home:      ${paths.home}`);
  console.log(`  workspace: ${paths.workspace}`);
  console.log(`  model:     ${cfg.model.provider}/${cfg.model.id}`);
  console.log(`  pi:        ${piBinary ?? "(not found)"}`);
  console.log(`  packages:  ${packagesInstalled.join(", ") || "(none)"}`);
  console.log(
    `  browser:   ${browserResult.cli ?? "(not installed)"}${browserResult.chromeOk ? " + Chrome" : ""}`,
  );
  console.log(
    `  telegram:  ${telegramConfigured ? chalk.green("configured") : chalk.yellow("not set")}`,
  );
  console.log(`  auth:      ${authOk ? chalk.green("ok") : chalk.yellow(authDetail || "needed")}`);
  console.log(`  auth file: ${piAuthPath(agentDir)}`);
  console.log("");
  console.log(chalk.bold("Next steps:"));
  let stepN = 1;
  if (!telegramConfigured) {
    console.log(`  ${stepN++}. Add TELEGRAM_BOT_TOKEN to ${paths.envFile}`);
  }
  if (telegramConfigured) {
    console.log(`  ${stepN++}. disk-agent models          # verify available models`);
    console.log(`  ${stepN++}. disk-agent gateway         # start Telegram + cron`);
    console.log(`  ${stepN++}. DM the bot → disk-agent pair <CODE>`);
  } else {
    console.log(`  ${stepN++}. disk-agent gateway`);
    console.log(`  ${stepN++}. DM the bot → disk-agent pair <CODE>`);
  }
  if (!authOk) {
    console.log(
      `  ${stepN++}. disk-agent login opencode-go --type api_key   # OpenCode Go subscription`,
    );
  }
  console.log("");
  console.log(chalk.dim("CLI-only (no Telegram):  disk-agent chat"));
  console.log(chalk.dim("Re-run setup anytime:    disk-agent setup"));
  console.log(chalk.dim("Diagnostics:             disk-agent doctor"));
  console.log("");

  const finalCfg = loadConfig({ dataDir: paths.home, workspaceDir: paths.workspace });

  return {
    cfg: finalCfg,
    paths,
    pi: {
      binary: piBinary,
      installed: piInstalled,
      packages: packagesInstalled,
      agentDir,
    },
    browser: browserResult,
    telegram: { configured: telegramConfigured },
    webSearchExtension: webSearchExt,
    auth: { attempted: authAttempted, ok: authOk, detail: authDetail },
    version,
  };
}

/**
 * Health check for install / paths / auth / extensions / browser.
 */
export async function runDoctor(opts?: {
  dataDir?: string;
  workspaceDir?: string;
}): Promise<number> {
  const version = getVersion();
  const paths = getPaths({ home: opts?.dataDir, workspace: opts?.workspaceDir });
  let exit = 0;

  console.log(chalk.bold.cyan(`\nDisk Agent doctor v${version}\n`));

  const checks: Array<{ name: string; ok: boolean; detail: string; soft?: boolean }> = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js ≥ 20.6",
    ok: nodeMajor > 20 || (nodeMajor === 20 && Number(process.versions.node.split(".")[1]) >= 6),
    detail: process.version,
  });

  const homeOk = existsSync(paths.home) && existsSync(paths.configFile);
  checks.push({
    name: "Home directory",
    ok: homeOk,
    detail: homeOk ? paths.home : `${paths.home} missing — run disk-agent setup`,
  });

  checks.push({
    name: "Workspace",
    ok: existsSync(paths.workspace),
    detail: paths.workspace,
  });

  checks.push({
    name: "Workspace skills",
    ok: existsSync(paths.workspaceSkills),
    detail: paths.workspaceSkills,
  });

  const pi = resolvePiBinary();
  checks.push({
    name: "Pi CLI",
    ok: Boolean(pi),
    detail: pi ?? "not found — run disk-agent setup",
  });

  const agentDir = resolvePiAgentDir();
  const settings = readPiSettings(agentDir);

  const hasWebSearchPkg = packageListed(settings.packages, "npm:pi-web-search");
  checks.push({
    name: "pi-web-search package",
    ok: hasWebSearchPkg || Boolean(resolveWebSearchExtension()),
    detail: hasWebSearchPkg
      ? "listed in ~/.pi/agent/settings.json"
      : (resolveWebSearchExtension() ?? "not installed"),
    soft: true,
  });

  const webSearchExt = resolveWebSearchExtension();
  checks.push({
    name: "pi-web-search extension file",
    ok: Boolean(webSearchExt),
    detail: webSearchExt ?? "missing — npm i pi-web-search",
    soft: true,
  });

  const hasBrowserPkg = packageListed(settings.packages, "npm:pi-agent-browser-native");
  checks.push({
    name: "pi-agent-browser-native",
    ok: hasBrowserPkg,
    detail: hasBrowserPkg ? "listed in pi settings" : "not installed — disk-agent setup",
    soft: true,
  });

  checks.push({
    name: "OPENCODE_API_KEY",
    ok: Boolean(
      process.env.OPENCODE_API_KEY?.trim() || readEnvValue(paths.envFile, "OPENCODE_API_KEY"),
    ),
    detail:
      process.env.OPENCODE_API_KEY?.trim() || readEnvValue(paths.envFile, "OPENCODE_API_KEY")
        ? "set (opencode / opencode-go)"
        : `missing — add OPENCODE_API_KEY to ${paths.envFile} for OpenCode Go (or: disk-agent login opencode-go --type api_key)`,
    soft: true,
  });

  const ab = whichCmd("agent-browser");
  checks.push({
    name: "agent-browser CLI",
    ok: Boolean(ab),
    detail: ab ?? `not found — ${AGENT_BROWSER_DOCS}`,
    soft: true,
  });

  let authOk = false;
  let authDetail = "unknown";
  try {
    authOk = await hasAnyAuth();
    authDetail = authOk
      ? "credentials found"
      : "no auth — disk-agent login opencode-go or provider API keys";
  } catch (err) {
    authDetail = err instanceof Error ? err.message : String(err);
  }
  checks.push({ name: "Auth", ok: authOk, detail: authDetail });

  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    readEnvValue(paths.envFile, "TELEGRAM_BOT_TOKEN") ||
    loadConfig({ dataDir: paths.home }).telegram.botToken;
  checks.push({
    name: "Telegram token",
    ok: Boolean(token),
    detail: token ? "configured" : `set TELEGRAM_BOT_TOKEN in ${paths.envFile}`,
    soft: true,
  });

  const voiceCfg = loadConfig({ dataDir: paths.home }).voice;
  const openaiStt = Boolean(
    process.env.OPENAI_API_KEY?.trim() || readEnvValue(paths.envFile, "OPENAI_API_KEY"),
  );
  const groqStt = Boolean(
    process.env.GROQ_API_KEY?.trim() || readEnvValue(paths.envFile, "GROQ_API_KEY"),
  );
  const sttReady =
    !voiceCfg.enabled ||
    voiceCfg.provider === "none" ||
    (voiceCfg.provider === "openai" && openaiStt) ||
    (voiceCfg.provider === "groq" && groqStt) ||
    (voiceCfg.provider === "auto" && (openaiStt || groqStt));
  let sttDetail: string;
  if (!voiceCfg.enabled) {
    sttDetail = "disabled (voice.enabled: false)";
  } else if (voiceCfg.provider === "none") {
    sttDetail = "download-only (voice.provider: none)";
  } else if (sttReady) {
    sttDetail = openaiStt
      ? `ready (openai${voiceCfg.provider === "auto" ? ", auto" : ""})`
      : `ready (groq${voiceCfg.provider === "auto" ? ", auto" : ""})`;
  } else {
    sttDetail = `no key — set OPENAI_API_KEY or GROQ_API_KEY in ${paths.envFile} for voice STT`;
  }
  checks.push({
    name: "Voice STT",
    ok: sttReady,
    detail: sttDetail,
    soft: true,
  });

  for (const c of checks) {
    if (c.ok) {
      console.log(`${chalk.green("✓")} ${c.name.padEnd(28)} ${chalk.dim(c.detail)}`);
    } else if (c.soft) {
      console.log(`${chalk.yellow("○")} ${c.name.padEnd(28)} ${c.detail}`);
    } else {
      console.log(`${chalk.red("✗")} ${c.name.padEnd(28)} ${c.detail}`);
      exit = 1;
    }
  }

  console.log("");
  if (exit === 0) console.log(chalk.green("Required checks passed. ○ = optional / recommended."));
  else console.log(chalk.yellow("Some required checks failed. Run: disk-agent setup"));
  console.log("");
  return exit;
}
