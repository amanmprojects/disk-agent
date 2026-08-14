import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function uid(prefix = ""): string {
  const id = randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. rename(2) is atomic within a filesystem, so readers never observe a
 * truncated or half-written file even if the process dies mid-write.
 */
export function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure — surface the original error */
    }
    throw err;
  }
}

export function writeJson(path: string, data: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function writeText(path: string, content: string): void {
  writeFileAtomic(path, content);
}

export function appendText(path: string, content: string): void {
  ensureDir(dirname(path));
  appendFileSync(path, content, "utf8");
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.startsWith("."));
}

/** Split long text into Telegram-safe chunks, preferring newline boundaries. */
export function chunkText(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Simple quiet-hours check using local time. */
export function inQuietHours(startHour: number, endHour: number, date = new Date()): boolean {
  const h = date.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  // wraps midnight, e.g. 23 -> 8
  return h >= startHour || h < endHour;
}

/** Very small keyword search over text blobs. */
export function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!q.length) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const term of q) {
    if (t.includes(term)) hits += 1;
  }
  return hits / q.length;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a promise, or reject with a timeout error once the deadline passes.
 * The timer is cleared when the underlying promise settles; a late settle is
 * ignored (handlers stay attached, so no unhandled rejection).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Serialize async work per key (session lane). */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail: Promise<void> = next.then(
      () => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      },
      () => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      },
    );
    this.tails.set(key, tail);
    return next;
  }
}
