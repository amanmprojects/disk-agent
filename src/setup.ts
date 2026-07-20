/**
 * One-command setup: home layout, pi CLI, extensions (pi-supergrok), auth, config.
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
import { resolveSupergrokExtension } from "./agent/pi.js";
import { getVersion } from "./version.js";

const require = createRequire(import.meta.url);

/** Default pi packages installed during setup. */
export const DEFAULT_PI_PACKAGES = ["npm:pi-supergrok"] as const;

export interface SetupOptions {
  agentName?: string;
  dataDir?: string;
  workspaceDir?: string;
  model?: string;
  telegramToken?: string;
  ownerId?: string;
  /** Skip ensuring pi CLI / packages */
  skipPi?: boolean;
  /** Skip SuperGrok login prompt */
  skipLogin?: boolean;
  /** Force SuperGrok OAuth even if already authenticated */
  forceLogin?: boolean;
  /** Non-interactive: no prompts; login only if --login */
  yes?: boolean;
  /** Explicitly request login (with --yes) */
  login?: boolean;
  /** Extra pi packages to install (npm:… specs) */
  packages?: string[];
  /** Write telegram token / owner into .env as well as config */
  writeEnv?: boolean;
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

function info(msg: string): void {
  console.log(chalk.dim("  · ") + msg);
}

function fail(msg: string): void {
  console.log(chalk.red("  ✗ ") + msg);
}

/** Resolve the pi CLI binary path (PATH, then dependency). */
export function resolvePiBinary(): string | null {
  // 1) PATH
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
    encoding: "utf8",
  });
  if (which.status === 0) {
    const line = which.stdout.trim().split("\n")[0]?.trim();
    if (line && existsSync(line)) return line;
  }

  // 2) dependency package
  try {
    const pkgJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const cli = join(dirname(pkgJson), "dist", "cli.js");
    if (existsSync(cli)) return cli;
  } catch {
    /* not found */
  }

  // 3) nested under this package when hoisted differently
  try {
    const here = dirname(require.resolve("disk-agent/package.json"));
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
    /* local dev name may not resolve */
  }

  return null;
}

function runNode(script: string, args: string[], opts?: { cwd?: string }): {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
} {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: opts?.cwd,
    env: process.env,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

function runCmd(cmd: string, args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
} {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
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

  info("pi not on PATH — installing @earendil-works/pi-coding-agent globally…");
  const npm = runCmd("npm", ["install", "-g", "@earendil-works/pi-coding-agent"]);
  if (!npm.ok) {
    // fall back to local dependency path after npm install of disk-agent
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

function packageListed(packages: string[] | undefined, spec: string): boolean {
  if (!packages?.length) return false;
  const name = spec.replace(/^npm:/, "").split("@")[0]!;
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
      info(`${pkg} already in pi settings`);
      installed.push(pkg);
      continue;
    }

    if (piBinary) {
      info(`pi install ${pkg}`);
      const isJs = piBinary.endsWith(".js");
      const result = isJs
        ? runNode(piBinary, ["install", pkg])
        : runCmd(piBinary, ["install", pkg]);

      if (result.ok) {
        installed.push(pkg);
        ok(`installed ${pkg}`);
        continue;
      }

      // fallback: append to settings and hope npm has the package via disk-agent deps
      warn(`pi install failed for ${pkg}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    }

    // Manual settings registration + ensure npm package present under pi agent npm tree
    current.push(pkg);
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
    if (npmInstall.ok || resolveSupergrokExtension()) {
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

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return defaultYes;
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

/**
 * Full first-run setup. Idempotent — safe to re-run.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const version = getVersion();
  const total = 5;
  console.log(chalk.bold.cyan(`\nDisk Agent v${version} — setup\n`));

  // ── 1. Home layout ──────────────────────────────────────────────────────
  step(1, total, "Initialize standardized home directory");
  const paths = getPaths({ home: opts.dataDir, workspace: opts.workspaceDir });
  ensureLayout(paths);
  const cfg = bootstrapHome({
    dataDir: paths.home,
    workspaceDir: paths.workspace,
    agentName: opts.agentName ?? "Disk",
  });

  if (opts.agentName) cfg.agentName = opts.agentName;
  if (opts.model) applyModel(cfg, opts.model);
  if (opts.telegramToken) {
    cfg.telegram.botToken = opts.telegramToken;
    cfg.telegram.enabled = true;
  }
  if (opts.ownerId) cfg.telegram.ownerId = String(opts.ownerId);
  if (opts.cwd) cfg.cwd = opts.cwd;

  saveConfig(cfg);
  ok(`home:      ${paths.home}`);
  ok(`workspace: ${paths.workspace}`);
  ok(`config:    ${paths.configFile}`);
  ok(`skills:    ${paths.workspaceSkills} (workspace), ${paths.userSkills} (user)`);
  info("layout:\n" + describeLayout(paths).split("\n").map((l) => "      " + l).join("\n"));

  if (opts.telegramToken || opts.ownerId || opts.model) {
    upsertEnv(paths.envFile, {
      TELEGRAM_BOT_TOKEN: opts.telegramToken,
      DISK_AGENT_OWNER_ID: opts.ownerId,
      DISK_AGENT_MODEL: opts.model,
    });
    if (existsSync(paths.envFile)) ok(`env:       ${paths.envFile}`);
  }

  // ── 2. Pi CLI ───────────────────────────────────────────────────────────
  step(2, total, "Ensure Pi coding-agent CLI");
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
  info(`pi agent dir: ${agentDir}`);

  // ── 3. Extensions ───────────────────────────────────────────────────────
  step(3, total, "Install Pi extensions (pi-supergrok, …)");
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

  // ── 4. Auth ─────────────────────────────────────────────────────────────
  step(4, total, "Authenticate (SuperGrok / xAI)");
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
        info("You can retry later: disk-agent login");
        info("Or set XAI_API_KEY in ~/.disk-agent/.env");
      }
    } else {
      authDetail = "deferred — run disk-agent login when ready";
      info(authDetail);
      if (process.env.XAI_API_KEY) {
        authOk = true;
        ok("XAI_API_KEY present in environment");
      }
    }
  }

  // ── 5. Summary ──────────────────────────────────────────────────────────
  step(5, total, "Done");
  console.log("");
  console.log(chalk.green.bold("✓ Disk Agent is ready"));
  console.log(`  version:   ${version}`);
  console.log(`  home:      ${paths.home}`);
  console.log(`  workspace: ${paths.workspace}`);
  console.log(`  model:     ${cfg.model.provider}/${cfg.model.id}`);
  console.log(`  pi:        ${piBinary ?? "(not found)"}`);
  console.log(`  packages:  ${packagesInstalled.join(", ") || "(none)"}`);
  console.log(`  auth:      ${authOk ? chalk.green("ok") : chalk.yellow(authDetail || "needed")}`);
  console.log(`  auth file: ${piAuthPath(agentDir)}`);
  console.log("");
  console.log(chalk.bold("Next steps:"));
  console.log("  1. disk-agent models          # verify SuperGrok models");
  console.log("  2. Edit secrets:              " + paths.envFile);
  console.log("       TELEGRAM_BOT_TOKEN=…     # from @BotFather");
  console.log("  3. disk-agent gateway         # start Telegram + cron");
  console.log("  4. DM the bot → disk-agent pair <CODE>");
  console.log("");
  console.log(chalk.dim("CLI-only (no Telegram):  disk-agent chat"));
  console.log(chalk.dim("Re-run setup anytime:    disk-agent setup"));
  console.log(chalk.dim("Diagnostics:             disk-agent doctor"));
  console.log("");

  // Reload config after any env writes
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
    supergrokExtension: ext,
    auth: { attempted: authAttempted, ok: authOk, detail: authDetail },
    version,
  };
}

/**
 * Health check for install / paths / auth / extensions.
 */
export async function runDoctor(opts?: { dataDir?: string; workspaceDir?: string }): Promise<number> {
  const version = getVersion();
  const paths = getPaths({ home: opts?.dataDir, workspace: opts?.workspaceDir });
  let exit = 0;

  console.log(chalk.bold.cyan(`\nDisk Agent doctor v${version}\n`));

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js ≥ 20.6",
    ok: nodeMajor > 20 || (nodeMajor === 20 && Number(process.versions.node.split(".")[1]) >= 6),
    detail: process.version,
  });

  // Home layout
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

  // Pi
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

  let authOk = false;
  let authDetail = "unknown";
  try {
    authOk = await hasAnyAuth();
    authDetail = authOk ? "credentials found" : "no auth — disk-agent login or XAI_API_KEY";
  } catch (err) {
    authDetail = err instanceof Error ? err.message : String(err);
  }
  checks.push({ name: "Auth", ok: authOk, detail: authDetail });

  for (const c of checks) {
    if (c.ok) console.log(chalk.green("✓") + ` ${c.name.padEnd(28)} ${chalk.dim(c.detail)}`);
    else {
      console.log(chalk.red("✗") + ` ${c.name.padEnd(28)} ${c.detail}`);
      exit = 1;
    }
  }

  console.log("");
  if (exit === 0) console.log(chalk.green("All checks passed."));
  else console.log(chalk.yellow("Some checks failed. Run: disk-agent setup"));
  console.log("");
  return exit;
}
