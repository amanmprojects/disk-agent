/**
 * One-command interactive setup:
 *   home layout → config (Telegram, model, …) → Pi CLI →
 *   Pi extensions (pi-supergrok, pi-agent-browser-native) →
 *   agent-browser CLI + Chrome → SuperGrok login
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import {
  bootstrapHome,
  loadConfig,
  saveConfig,
  type AppConfig,
} from "./config.js";
import {
  describeLayout,
  ensureLayout,
  getPaths,
  piAuthPath,
  piSettingsPath,
  resolvePiAgentDir,
  type DiskAgentPaths,
} from "./paths.js";
import { loginProvider, hasAnyAuth } from "./auth/login.js";
import { resolveSupergrokExtension, resolveTavilyExtension } from "./agent/pi.js";
import { getVersion } from "./version.js";

const require = createRequire(import.meta.url);

/**
 * Default Pi packages installed during setup.
 * - pi-supergrok: SuperGrok / xAI OAuth provider
 * - pi-agent-browser-native: exposes agent-browser as a native Pi tool
 * - @tavily/pi-extension: web_search + web_fetch (needs TAVILY_API_KEY)
 */
export const DEFAULT_PI_PACKAGES = [
  "npm:pi-supergrok",
  "npm:pi-agent-browser-native",
  "npm:@tavily/pi-extension",
] as const;

/** Docs: https://agent-browser.dev/ */
export const AGENT_BROWSER_DOCS = "https://agent-browser.dev/";

export interface SetupOptions {
  agentName?: string;
  dataDir?: string;
  workspaceDir?: string;
  model?: string;
  telegramToken?: string;
  ownerId?: string;
  /** Tavily API key for web_search / web_fetch */
  tavilyApiKey?: string;
  /** Skip ensuring pi CLI / packages */
  skipPi?: boolean;
  /** Skip agent-browser CLI + Chrome download */
  skipBrowser?: boolean;
  /** Skip SuperGrok login prompt */
  skipLogin?: boolean;
  /** Force SuperGrok OAuth even if already authenticated */
  forceLogin?: boolean;
  /** Non-interactive: no prompts; skip optional login/browser confirm unless forced */
  yes?: boolean;
  /** Explicitly request login (with --yes) */
  login?: boolean;
  /** Extra pi packages to install (npm:… specs) */
  packages?: string[];
  cwd?: string;
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
  tavily: { configured: boolean };
  supergrokExtension: string | null;
  auth: { attempted: boolean; ok: boolean; detail: string };
  version: string;
}

function step(n: number, total: number, msg: string): void {
  console.log(chalk.bold(`\n[${n}/${total}]`) + ` ${msg}`);
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
  writeFileSync(piSettingsPath(agentDir), JSON.stringify(data, null, 2) + "\n", "utf8");
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
): { installed: string[]; failed: Array<{ pkg: string; error: string }> } {
  const agentDir = resolvePiAgentDir();
  mkdirSync(agentDir, { recursive: true });

  const installed: string[] = [];
  const failed: Array<{ pkg: string; error: string }> = [];
  const settings = readPiSettings(agentDir);
  const current = Array.isArray(settings.packages) ? [...settings.packages] : [];

  for (const pkg of packages) {
    if (packageListed(current, pkg)) {
      ok(`${pkg} already in pi settings`);
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
        ok(`installed ${pkg}`);
        // refresh settings view
        const refreshed = readPiSettings(agentDir);
        if (Array.isArray(refreshed.packages)) {
          current.splice(0, current.length, ...refreshed.packages);
        } else if (!packageListed(current, pkg)) {
          current.push(pkg);
        }
        continue;
      }

      warn(`pi install failed for ${pkg}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
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
      ok(`registered ${pkg} in ${piSettingsPath(agentDir)}`);
    } else {
      failed.push({
        pkg,
        error: npmInstall.stderr.trim() || npmInstall.stdout.trim() || "install failed",
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
}): Promise<{
  cli: string | null;
  installed: boolean;
  chromeOk: boolean;
  detail: string;
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
    ok(`agent-browser installed → ${cli}`);
  } else {
    ok(`agent-browser found → ${cli}`);
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
    ok("browser backend ready (Chrome)");
    return {
      cli,
      installed: true,
      chromeOk: true,
      detail: "CLI + Chrome ready",
    };
  }

  // Some versions already have Chrome — treat non-zero with existing CLI as soft fail
  warn(
    `agent-browser install: ${(install.stderr || install.stdout).trim().slice(0, 200) || "non-zero exit"}`,
  );
  return {
    cli,
    installed: true,
    chromeOk: false,
    detail: "CLI installed; Chrome download may need: agent-browser install",
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
      text += line + "\n";
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

/**
 * Interactive prompts for agent name, model, Telegram, Tavily, owner, cwd.
 * Flags / existing env take precedence; --yes skips prompts (keeps defaults / flags).
 */
async function collectUserConfig(
  cfg: AppConfig,
  paths: DiskAgentPaths,
  opts: SetupOptions,
): Promise<{
  agentName: string;
  model?: string;
  telegramToken?: string;
  ownerId?: string;
  tavilyApiKey?: string;
  cwd?: string;
}> {
  const existingToken =
    opts.telegramToken ||
    cfg.telegram.botToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    readEnvValue(paths.envFile, "TELEGRAM_BOT_TOKEN");
  const existingOwner =
    opts.ownerId ||
    cfg.telegram.ownerId ||
    process.env.DISK_AGENT_OWNER_ID ||
    readEnvValue(paths.envFile, "DISK_AGENT_OWNER_ID");
  const existingTavily =
    opts.tavilyApiKey ||
    process.env.TAVILY_API_KEY ||
    readEnvValue(paths.envFile, "TAVILY_API_KEY");
  const existingModel =
    opts.model ||
    process.env.DISK_AGENT_MODEL ||
    `${cfg.model.provider}/${cfg.model.id}`;
  const existingName = opts.agentName || cfg.agentName || "Disk";
  const existingCwd = opts.cwd || process.env.DISK_AGENT_CWD || cfg.cwd;

  if (opts.yes || !isInteractive()) {
    return {
      agentName: existingName,
      model: opts.model || existingModel,
      telegramToken: existingToken,
      ownerId: existingOwner,
      tavilyApiKey: existingTavily,
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

  console.log("");
  console.log(
    chalk.dim(
      "  Tavily web search (optional — https://app.tavily.com for an API key)",
    ),
  );
  console.log(
    chalk.dim("  Enables web_search + web_fetch via @tavily/pi-extension"),
  );
  let tavilyApiKey = existingTavily;
  if (existingTavily) {
    ok(`tavily:    existing key detected (${maskSecret(existingTavily)})`);
    if (await confirm("Replace Tavily API key?", false)) {
      tavilyApiKey = await ask("TAVILY_API_KEY", { secret: true });
    }
  } else {
    tavilyApiKey = await ask("TAVILY_API_KEY (leave empty to skip)", {
      secret: true,
    });
  }

  return {
    agentName: agentName || "Disk",
    model: model || existingModel,
    telegramToken: telegramToken || undefined,
    ownerId: ownerId || undefined,
    tavilyApiKey: tavilyApiKey || undefined,
    cwd: cwd || existingCwd,
  };
}

/**
 * Full first-run setup. Idempotent — safe to re-run.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const version = getVersion();
  const total = 7;
  console.log(chalk.bold.cyan(`\nDisk Agent v${version} — setup\n`));
  console.log(
    chalk.dim(
      "This wizard installs Pi, SuperGrok, Tavily, agent-browser, and configures home + Telegram.\n",
    ),
  );

  // ── 1. Home layout ──────────────────────────────────────────────────────
  step(1, total, "Initialize standardized home directory");
  const paths = getPaths({ home: opts.dataDir, workspace: opts.workspaceDir });
  ensureLayout(paths);
  let cfg = bootstrapHome({
    dataDir: paths.home,
    workspaceDir: paths.workspace,
    agentName: opts.agentName ?? "Disk",
  });
  ok(`home:      ${paths.home}`);
  ok(`workspace: ${paths.workspace}`);
  ok(`config:    ${paths.configFile}`);
  ok(`skills:    ${paths.workspaceSkills} (workspace), ${paths.userSkills} (user)`);
  ok(
    "layout:\n" +
      describeLayout(paths)
        .split("\n")
        .map((l) => "      " + l)
        .join("\n"),
  );

  // ── 2. Interactive config (Telegram, Tavily, model, …) ──────────────────
  step(2, total, "Agent, Telegram & Tavily configuration");
  const user = await collectUserConfig(cfg, paths, opts);

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
    TAVILY_API_KEY: user.tavilyApiKey,
  });
  if (user.tavilyApiKey) {
    process.env.TAVILY_API_KEY = user.tavilyApiKey;
  }

  ok(`agent:     ${cfg.agentName}`);
  ok(`model:     ${cfg.model.provider}/${cfg.model.id}`);
  ok(`cwd:       ${cfg.cwd}`);
  if (user.telegramToken) {
    ok(`telegram:  enabled (token saved to ${paths.envFile})`);
    if (user.ownerId) ok(`owner:     ${user.ownerId}`);
  } else {
    warn(`telegram:  not configured — add TELEGRAM_BOT_TOKEN to ${paths.envFile}`);
  }
  if (user.tavilyApiKey) {
    ok(`tavily:    API key saved to ${paths.envFile} (web_search / web_fetch)`);
  } else {
    warn(
      `tavily:    not configured — add TAVILY_API_KEY to ${paths.envFile} for web search`,
    );
  }

  // ── 3. Pi CLI ───────────────────────────────────────────────────────────
  step(3, total, "Ensure Pi coding-agent CLI");
  let piBinary: string | null = null;
  let piInstalled = false;
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

  const agentDir = resolvePiAgentDir();
  ok(`pi agent dir: ${agentDir}`);

  // ── 4. Pi extensions ────────────────────────────────────────────────────
  step(4, total, "Install Pi extensions (pi-supergrok, pi-agent-browser-native, …)");
  const wanted = [...new Set([...(opts.packages ?? DEFAULT_PI_PACKAGES)])];
  let packagesInstalled: string[] = [];
  if (opts.skipPi) {
    warn("skipped package install");
    packagesInstalled = wanted.filter((p) =>
      packageListed(readPiSettings(agentDir).packages, p),
    );
  } else {
    const result = ensurePiPackages(piBinary, wanted);
    packagesInstalled = result.installed;
    for (const f of result.failed) {
      fail(`${f.pkg}: ${f.error}`);
    }
  }

  const ext = resolveSupergrokExtension();
  if (ext) ok(`pi-supergrok extension: ${ext}`);
  else warn("pi-supergrok extension not resolved — login may fail until it is installed");

  const tavilyExt = resolveTavilyExtension();
  if (tavilyExt) ok(`tavily extension: ${tavilyExt}`);
  else warn("tavily extension not resolved — npm i @tavily/pi-extension");

  if (packageListed(packagesInstalled, "npm:pi-agent-browser-native")) {
    ok("pi-agent-browser-native registered");
  }
  if (packageListed(packagesInstalled, "npm:@tavily/pi-extension")) {
    ok("@tavily/pi-extension registered");
  }

  // ── 5. agent-browser CLI + Chrome ───────────────────────────────────────
  step(5, total, `Install agent-browser (${AGENT_BROWSER_DOCS})`);
  let browserResult: SetupResult["browser"] = {
    cli: whichCmd("agent-browser"),
    installed: Boolean(whichCmd("agent-browser")),
    chromeOk: false,
    detail: "skipped",
  };

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
      (await confirm(
        "Install agent-browser for full browser automation? (recommended)",
        true,
      ));
    if (want) {
      browserResult = await ensureAgentBrowser();
      // Success lines already printed by ensureAgentBrowser
      if (!browserResult.installed) fail(browserResult.detail);
    } else {
      warn("skipped agent-browser — web_get will use plain fetch only");
      browserResult.detail = "skipped by user";
    }
  }

  // ── 6. Auth ─────────────────────────────────────────────────────────────
  step(6, total, "Authenticate (SuperGrok / xAI)");
  let authAttempted = false;
  let authOk = false;
  let authDetail = "";

  const already = await hasAnyAuth();
  if (already && !opts.forceLogin) {
    authOk = true;
    authDetail = "credentials already present";
    ok(authDetail);
  } else if (opts.skipLogin) {
    authDetail = "skipped (--skip-login)";
    warn(authDetail);
  } else {
    const shouldLogin =
      opts.login === true ||
      opts.forceLogin === true ||
      (!opts.yes && (await confirm("Log in with SuperGrok / X Premium now?", true)));

    if (shouldLogin) {
      authAttempted = true;
      const result = await loginProvider("supergrok", { force: opts.forceLogin });
      authOk = result.ok;
      authDetail = result.ok ? `logged in as supergrok` : result.error;
      if (result.ok) ok(authDetail);
      else {
        fail(authDetail);
        console.log(chalk.dim("    You can retry later: disk-agent login"));
        console.log(chalk.dim(`    Or set XAI_API_KEY in ${paths.envFile}`));
      }
    } else {
      authDetail = "deferred — run disk-agent login when ready";
      warn(authDetail);
      if (process.env.XAI_API_KEY || readEnvValue(paths.envFile, "XAI_API_KEY")) {
        authOk = true;
        ok("XAI_API_KEY present");
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
  const tavilyConfigured = Boolean(
    process.env.TAVILY_API_KEY?.trim() ||
      readEnvValue(paths.envFile, "TAVILY_API_KEY"),
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
  console.log(
    `  tavily:    ${tavilyConfigured ? chalk.green("configured") : chalk.yellow("not set (web search disabled)")}`,
  );
  console.log(
    `  auth:      ${authOk ? chalk.green("ok") : chalk.yellow(authDetail || "needed")}`,
  );
  console.log(`  auth file: ${piAuthPath(agentDir)}`);
  console.log("");
  console.log(chalk.bold("Next steps:"));
  let stepN = 1;
  if (!telegramConfigured) {
    console.log(`  ${stepN++}. Add TELEGRAM_BOT_TOKEN to ${paths.envFile}`);
  }
  if (!tavilyConfigured) {
    console.log(`  ${stepN++}. Add TAVILY_API_KEY to ${paths.envFile} for web search`);
  }
  if (telegramConfigured) {
    console.log(`  ${stepN++}. disk-agent models          # verify SuperGrok models`);
    console.log(`  ${stepN++}. disk-agent gateway         # start Telegram + cron`);
    console.log(`  ${stepN++}. DM the bot → disk-agent pair <CODE>`);
  } else {
    console.log(`  ${stepN++}. disk-agent gateway`);
    console.log(`  ${stepN++}. DM the bot → disk-agent pair <CODE>`);
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
    tavily: { configured: tavilyConfigured },
    supergrokExtension: ext,
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

  const hasSg = packageListed(settings.packages, "npm:pi-supergrok");
  checks.push({
    name: "pi-supergrok package",
    ok: hasSg || Boolean(resolveSupergrokExtension()),
    detail: hasSg
      ? "listed in ~/.pi/agent/settings.json"
      : resolveSupergrokExtension() ?? "not installed",
  });

  const ext = resolveSupergrokExtension();
  checks.push({
    name: "pi-supergrok extension file",
    ok: Boolean(ext),
    detail: ext ?? "missing",
  });

  const hasBrowserPkg = packageListed(settings.packages, "npm:pi-agent-browser-native");
  checks.push({
    name: "pi-agent-browser-native",
    ok: hasBrowserPkg,
    detail: hasBrowserPkg ? "listed in pi settings" : "not installed — disk-agent setup",
    soft: true,
  });

  const tavilyExt = resolveTavilyExtension();
  const hasTavilyPkg = packageListed(settings.packages, "npm:@tavily/pi-extension");
  checks.push({
    name: "@tavily/pi-extension",
    ok: Boolean(tavilyExt) || hasTavilyPkg,
    detail: tavilyExt
      ? tavilyExt
      : hasTavilyPkg
        ? "listed in pi settings"
        : "not installed — npm i @tavily/pi-extension",
    soft: true,
  });
  checks.push({
    name: "TAVILY_API_KEY",
    ok: Boolean(process.env.TAVILY_API_KEY?.trim() || readEnvValue(paths.envFile, "TAVILY_API_KEY")),
    detail:
      process.env.TAVILY_API_KEY?.trim() || readEnvValue(paths.envFile, "TAVILY_API_KEY")
        ? "set"
        : `missing — add TAVILY_API_KEY to ${paths.envFile}`,
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
    authDetail = authOk ? "credentials found" : "no auth — disk-agent login or XAI_API_KEY";
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
      console.log(chalk.green("✓") + ` ${c.name.padEnd(28)} ${chalk.dim(c.detail)}`);
    } else if (c.soft) {
      console.log(chalk.yellow("○") + ` ${c.name.padEnd(28)} ${c.detail}`);
    } else {
      console.log(chalk.red("✗") + ` ${c.name.padEnd(28)} ${c.detail}`);
      exit = 1;
    }
  }

  console.log("");
  if (exit === 0) console.log(chalk.green("Required checks passed. ○ = optional / recommended."));
  else console.log(chalk.yellow("Some required checks failed. Run: disk-agent setup"));
  console.log("");
  return exit;
}
