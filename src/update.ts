/**
 * Self-update: install the latest (or pinned) npm package and restart the gateway.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getVersion } from "./version.js";
import {
  getDaemonStatus,
  resolveCliEntry,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type StartDaemonOptions,
} from "./daemon.js";

/** Published package name on npm. */
export const PACKAGE_NAME = "@amanm/disk-agent";

export interface UpdateOptions {
  /** Version or dist-tag (default: latest). Accepts `1.2.3`, `v1.2.3`, `latest`, `next`. */
  version?: string;
  dataDir?: string;
  workspaceDir?: string;
  cwd?: string;
  /** Skip gateway stop/start after install. */
  noRestart?: boolean;
  /** Only report current vs registry version; do not install. */
  check?: boolean;
}

export interface UpdateResult {
  ok: boolean;
  previousVersion: string;
  newVersion?: string;
  latestVersion?: string;
  /** Whether npm install was run. */
  installed: boolean;
  /** Whether the detached gateway was restarted (or started after a prior stop). */
  restarted: boolean;
  /** True when already on the target version and no install was needed. */
  upToDate?: boolean;
  message: string;
  gatewayMessage?: string;
}

function runCmd(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: process.env,
    timeout: opts?.timeoutMs ?? 600_000,
    // Inherit so npm progress / peer warnings are visible
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

/**
 * Normalize a user version argument into an npm package specifier.
 * `@amanm/disk-agent` + `latest` → `@amanm/disk-agent@latest`
 * `@amanm/disk-agent` + `v1.2.3` → `@amanm/disk-agent@1.2.3`
 */
export function packageSpec(version?: string): string {
  const raw = (version ?? "latest").trim();
  if (!raw) return `${PACKAGE_NAME}@latest`;
  // Full package@spec already
  if (raw.startsWith(`${PACKAGE_NAME}@`)) return raw;
  if (raw === PACKAGE_NAME || raw === "disk-agent") return `${PACKAGE_NAME}@latest`;
  // Strip a leading `v` only when it prefixes a version number (v1.2.3 → 1.2.3)
  const v = raw.replace(/^v(?=\d)/, "");
  return `${PACKAGE_NAME}@${v}`;
}

/** Query the registry for a dist-tag or version. */
export function fetchRegistryVersion(tagOrVersion = "latest"): string | null {
  const r = runCmd("npm", ["view", `${PACKAGE_NAME}@${tagOrVersion}`, "version"], {
    timeoutMs: 60_000,
  });
  if (!r.ok) return null;
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  return line || null;
}

/**
 * Read version from the installed package root (disk), not in-memory fallback.
 */
export function readInstalledVersion(): string | null {
  const root = resolveInstalledPackageRoot();
  if (!root) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function resolveInstalledPackageRoot(): string | null {
  // Prefer the package that owns the running CLI entry
  try {
    const entry = resolveCliEntry();
    const resolved = existsSync(entry) ? realpathSync(entry) : entry;
    // …/node_modules/@amanm/disk-agent/dist/cli.js → package root
    const markers = [
      `${sep}node_modules${sep}@amanm${sep}disk-agent${sep}`,
      `${sep}node_modules${sep}disk-agent${sep}`,
    ];
    for (const m of markers) {
      const idx = resolved.lastIndexOf(m);
      if (idx !== -1) {
        const root = resolved.slice(0, idx + m.length - 1); // drop trailing sep
        if (existsSync(join(root, "package.json"))) return root;
      }
    }
    // dist/cli.js next to package.json (linked / from-source layout)
    const distParent = dirname(resolved);
    if (distParent.endsWith(`${sep}dist`)) {
      const root = dirname(distParent);
      if (existsSync(join(root, "package.json"))) {
        try {
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            name?: string;
          };
          if (pkg.name === PACKAGE_NAME || pkg.name === "disk-agent") return root;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${PACKAGE_NAME}/package.json`));
  } catch {
    /* ignore */
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..");
    if (existsSync(join(root, "package.json"))) return root;
  } catch {
    /* ignore */
  }

  return null;
}

function npmInstallGlobal(spec: string): { ok: boolean; detail: string } {
  const r = runCmd("npm", ["install", "-g", spec], { timeoutMs: 600_000 });
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  if (r.ok) {
    return { ok: true, detail: out || `installed ${spec}` };
  }
  return {
    ok: false,
    detail:
      out ||
      `npm install -g ${spec} failed (exit ${r.code ?? "?"}). Try: npm install -g ${spec}`,
  };
}

function daemonOpts(opts: UpdateOptions): StartDaemonOptions {
  return {
    dataDir: opts.dataDir,
    workspaceDir: opts.workspaceDir,
    cwd: opts.cwd,
  };
}

/**
 * Update the global `@amanm/disk-agent` package and restart the detached gateway
 * so the new code is loaded.
 */
export function runUpdate(opts: UpdateOptions = {}): UpdateResult {
  const previousVersion = getVersion();
  const tag = (opts.version ?? "latest").trim().replace(/^v(?=\d)/, "") || "latest";
  const spec = packageSpec(opts.version);

  const latestVersion = fetchRegistryVersion(tag === "latest" || tag === "next" ? tag : tag);

  if (opts.check) {
    const target = latestVersion ?? tag;
    const upToDate = latestVersion != null && latestVersion === previousVersion;
    return {
      ok: true,
      previousVersion,
      latestVersion: latestVersion ?? undefined,
      newVersion: previousVersion,
      installed: false,
      restarted: false,
      upToDate,
      message: upToDate
        ? `Already up to date (v${previousVersion})`
        : latestVersion
          ? `Update available: v${previousVersion} → v${latestVersion}  (run: disk-agent update)`
          : `Current: v${previousVersion}; could not query registry for ${PACKAGE_NAME}@${tag}`,
    };
  }

  // Already on the requested version (when we could resolve it) — still restart gateway
  if (
    latestVersion &&
    latestVersion === previousVersion &&
    (tag === "latest" || tag === "next" || tag === latestVersion)
  ) {
    let restarted = false;
    let gatewayMessage: string | undefined;
    if (!opts.noRestart) {
      const r = restartDaemon(daemonOpts(opts));
      restarted = r.ok;
      gatewayMessage = r.message;
    }
    return {
      ok: true,
      previousVersion,
      newVersion: previousVersion,
      latestVersion,
      installed: false,
      restarted,
      upToDate: true,
      message: `Already up to date (v${previousVersion})`,
      gatewayMessage,
    };
  }

  const statusBefore = getDaemonStatus(opts.dataDir);
  const wasRunning = Boolean(statusBefore.running);

  // Stop gateway before replacing package files so the worker exits cleanly
  if (wasRunning && !opts.noRestart) {
    stopDaemon(opts.dataDir);
  }

  const install = npmInstallGlobal(spec);
  if (!install.ok) {
    // Best-effort: bring gateway back if we stopped it
    if (wasRunning && !opts.noRestart) {
      startDaemon(daemonOpts(opts));
    }
    return {
      ok: false,
      previousVersion,
      latestVersion: latestVersion ?? undefined,
      installed: false,
      restarted: false,
      message: install.detail,
    };
  }

  // Re-read from disk after npm wrote the new package
  const newVersion = readInstalledVersion() ?? latestVersion ?? tag;

  let restarted = false;
  let gatewayMessage: string | undefined;

  if (!opts.noRestart) {
    // Always restart (stop was above if needed; start loads the new package)
    const start = startDaemon(daemonOpts(opts));
    restarted = start.ok;
    gatewayMessage = start.message;
    if (!start.ok) {
      return {
        ok: false,
        previousVersion,
        newVersion,
        latestVersion: latestVersion ?? undefined,
        installed: true,
        restarted: false,
        message: `Updated v${previousVersion} → v${newVersion}, but gateway failed to start`,
        gatewayMessage: start.message,
      };
    }
  }

  const changed = newVersion !== previousVersion;
  return {
    ok: true,
    previousVersion,
    newVersion,
    latestVersion: latestVersion ?? undefined,
    installed: true,
    restarted,
    upToDate: !changed,
    message: changed
      ? `Updated v${previousVersion} → v${newVersion}`
      : `Reinstalled v${newVersion} (${spec})`,
    gatewayMessage,
  };
}
