/**
 * Detached gateway process management (start/stop/status/restart).
 * Runs the gateway as an OS process independent of the controlling terminal.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "./paths.js";

export interface DaemonInfo {
  running: boolean;
  pid: number | null;
  pidFile: string;
  logFile: string;
  startedAt?: string;
  stale?: boolean;
}

export function pidFilePath(dataDir: string): string {
  return join(dataDir, "gateway.pid");
}

export function daemonMetaPath(dataDir: string): string {
  return join(dataDir, "gateway.daemon.json");
}

export function gatewayLogPath(dataDir: string): string {
  return join(dataDir, "logs", "gateway.log");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const n = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function clearPid(dataDir: string): void {
  const pf = pidFilePath(dataDir);
  const mf = daemonMetaPath(dataDir);
  try {
    if (existsSync(pf)) unlinkSync(pf);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(mf)) unlinkSync(mf);
  } catch {
    /* ignore */
  }
}

export function getDaemonStatus(dataDir?: string): DaemonInfo {
  const paths = getPaths({ home: dataDir });
  const pidFile = pidFilePath(paths.home);
  const logFile = gatewayLogPath(paths.home);
  const pid = readPid(pidFile);
  if (!pid) {
    return { running: false, pid: null, pidFile, logFile };
  }
  const alive = isAlive(pid);
  let startedAt: string | undefined;
  try {
    if (existsSync(daemonMetaPath(paths.home))) {
      const meta = JSON.parse(readFileSync(daemonMetaPath(paths.home), "utf8")) as {
        startedAt?: string;
      };
      startedAt = meta.startedAt;
    }
  } catch {
    /* ignore */
  }
  if (!alive) {
    return {
      running: false,
      pid,
      pidFile,
      logFile,
      startedAt,
      stale: true,
    };
  }
  return { running: true, pid, pidFile, logFile, startedAt };
}

/** Resolve the disk-agent CLI entry (dist/cli.js or argv[1]). */
export function resolveCliEntry(): string {
  // Prefer the currently executing script
  if (process.argv[1] && existsSync(process.argv[1])) {
    return process.argv[1];
  }
  try {
    return fileURLToPath(new URL("./cli.js", import.meta.url));
  } catch {
    return process.argv[1] || "disk-agent";
  }
}

export interface StartDaemonOptions {
  dataDir?: string;
  workspaceDir?: string;
  cwd?: string;
  /** Extra args after `gateway run` */
  extraArgs?: string[];
}

/**
 * Start gateway in detached mode (survives terminal close / VPS logout).
 */
export function startDaemon(opts: StartDaemonOptions = {}): {
  ok: boolean;
  message: string;
  info: DaemonInfo;
} {
  const paths = getPaths({ home: opts.dataDir, workspace: opts.workspaceDir });
  mkdirSync(paths.logs, { recursive: true });

  const current = getDaemonStatus(paths.home);
  if (current.running && current.pid) {
    return {
      ok: true,
      message: `Gateway already running (pid ${current.pid})`,
      info: current,
    };
  }
  if (current.stale) {
    clearPid(paths.home);
  }

  const entry = resolveCliEntry();
  const args = [entry, "gateway", "run"];
  if (opts.dataDir) args.push("--data-dir", opts.dataDir);
  if (opts.workspaceDir) args.push("--workspace", opts.workspaceDir);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);

  const logFile = gatewayLogPath(paths.home);
  const outFd = openSync(logFile, "a");
  const errFd = openSync(logFile, "a");

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: {
        ...process.env,
        DISK_AGENT_DAEMON: "1",
      },
      cwd: process.cwd(),
    });
  } finally {
    // Parent no longer needs the fds; child has them
    try {
      closeSync(outFd);
    } catch {
      /* ignore */
    }
    try {
      closeSync(errFd);
    } catch {
      /* ignore */
    }
  }

  if (!child.pid) {
    return {
      ok: false,
      message: "Failed to spawn gateway process",
      info: getDaemonStatus(paths.home),
    };
  }

  writeFileSync(pidFilePath(paths.home), String(child.pid) + "\n", "utf8");
  writeFileSync(
    daemonMetaPath(paths.home),
    JSON.stringify(
      {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        entry,
        args,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  child.unref();

  // Brief settle — detect immediate crash
  const pid = child.pid;
  sleepSync(500);
  if (!isAlive(pid)) {
    clearPid(paths.home);
    return {
      ok: false,
      message: `Gateway exited immediately — check ${logFile}`,
      info: getDaemonStatus(paths.home),
    };
  }

  const info = getDaemonStatus(paths.home);
  return {
    ok: true,
    message: `Gateway started (pid ${pid})\n  log: ${logFile}\n  stop: disk-agent gateway stop`,
    info,
  };
}

/**
 * Stop a detached gateway process.
 */
export function stopDaemon(dataDir?: string): {
  ok: boolean;
  message: string;
  info: DaemonInfo;
} {
  const paths = getPaths({ home: dataDir });
  const status = getDaemonStatus(paths.home);

  if (!status.pid) {
    return {
      ok: true,
      message: "Gateway is not running",
      info: status,
    };
  }

  if (status.stale || !status.running) {
    clearPid(paths.home);
    return {
      ok: true,
      message: `Cleared stale pid file (was ${status.pid})`,
      info: getDaemonStatus(paths.home),
    };
  }

  const pid = status.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    clearPid(paths.home);
    return {
      ok: false,
      message: `Failed to signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`,
      info: getDaemonStatus(paths.home),
    };
  }

  // Wait up to ~5s for exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    sleepSync(100);
  }

  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    sleepSync(200);
  }

  clearPid(paths.home);

  if (isAlive(pid)) {
    return {
      ok: false,
      message: `Gateway pid ${pid} still alive after SIGKILL`,
      info: getDaemonStatus(paths.home),
    };
  }

  return {
    ok: true,
    message: `Gateway stopped (was pid ${pid})`,
    info: getDaemonStatus(paths.home),
  };
}

export function restartDaemon(opts: StartDaemonOptions = {}): {
  ok: boolean;
  message: string;
  info: DaemonInfo;
} {
  const stop = stopDaemon(opts.dataDir);
  const start = startDaemon(opts);
  return {
    ok: start.ok,
    message: [stop.message, start.message].join("\n"),
    info: start.info,
  };
}

/**
 * Called by the long-running gateway process to claim the pid file
 * when started via `gateway run` under the daemon supervisor.
 * Also cleans up pid on exit.
 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

export function writeRuntimePid(dataDir: string): void {
  const pid = process.pid;
  writeFileSync(pidFilePath(dataDir), String(pid) + "\n", "utf8");
  writeFileSync(
    daemonMetaPath(dataDir),
    JSON.stringify(
      {
        pid,
        startedAt: new Date().toISOString(),
        mode: process.env.DISK_AGENT_DAEMON ? "daemon" : "foreground",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const cleanup = () => {
    try {
      const current = readPid(pidFilePath(dataDir));
      if (current === pid) clearPid(dataDir);
    } catch {
      /* ignore */
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
  });
  process.once("SIGTERM", () => {
    cleanup();
  });
}
