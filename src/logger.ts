import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type { LogLevel } from "./types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private level: LogLevel;
  private filePath?: string;

  constructor(opts?: { level?: LogLevel; filePath?: string }) {
    this.level = opts?.level ?? "info";
    this.filePath = opts?.filePath;
    if (this.filePath) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private should(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    if (!this.should(level)) return;
    const ts = new Date().toISOString();
    const line =
      meta === undefined
        ? `[${ts}] ${level.toUpperCase()} ${msg}`
        : `[${ts}] ${level.toUpperCase()} ${msg} ${safeJson(meta)}`;

    const colored =
      level === "debug"
        ? chalk.gray(line)
        : level === "info"
          ? chalk.cyan(line)
          : level === "warn"
            ? chalk.yellow(line)
            : chalk.red(line);

    if (level === "error") console.error(colored);
    else console.log(colored);

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + "\n", "utf8");
      } catch {
        // ignore file write errors
      }
    }
  }

  debug(msg: string, meta?: unknown): void {
    this.write("debug", msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.write("info", msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.write("warn", msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.write("error", msg, meta);
  }

  child(prefix: string): Logger {
    const parent = this;
    const child = new Logger({ level: this.level, filePath: this.filePath });
    const wrap =
      (fn: (m: string, meta?: unknown) => void) => (msg: string, meta?: unknown) =>
        fn.call(parent, `[${prefix}] ${msg}`, meta);
    child.debug = wrap(parent.debug.bind(parent));
    child.info = wrap(parent.info.bind(parent));
    child.warn = wrap(parent.warn.bind(parent));
    child.error = wrap(parent.error.bind(parent));
    return child;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function defaultLogPath(dataDir: string): string {
  return join(dataDir, "logs", "gateway.log");
}
