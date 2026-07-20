import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { ChannelId, SessionRecord } from "../types.js";
import { ensureDir, hashKey, nowIso, readJson, uid, writeJson } from "../utils.js";

export function makeSessionKey(channel: ChannelId, peerId: string): string {
  return `${channel}:${peerId}`;
}

/**
 * Tracks logical conversation sessions and maps them to Pi SessionManager files.
 * One lane per (channel, peer) — serialized by the gateway queue.
 *
 * Each peer gets its own Pi session directory so continueRecent() is peer-scoped.
 */
export class SessionRegistry {
  private indexPath: string;
  private sessionsDir: string;
  private piSessionsDir: string;

  constructor(cfg: AppConfig) {
    this.sessionsDir = join(cfg.dataDir, "sessions");
    this.piSessionsDir = join(cfg.dataDir, "pi-sessions");
    this.indexPath = join(this.sessionsDir, "index.json");
    ensureDir(this.sessionsDir);
    ensureDir(this.piSessionsDir);
  }

  list(): SessionRecord[] {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    return Object.values(idx).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(key: string): SessionRecord | undefined {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    return idx[key];
  }

  getOrCreate(channel: ChannelId, peerId: string, title?: string): SessionRecord {
    const key = makeSessionKey(channel, peerId);
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    const existing = idx[key];
    if (existing) {
      existing.updatedAt = nowIso();
      idx[key] = existing;
      writeJson(this.indexPath, idx);
      return existing;
    }
    const rec: SessionRecord = {
      key,
      channel,
      peerId,
      sessionId: uid("sess"),
      title: title ?? `${channel}:${peerId}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messageCount: 0,
    };
    idx[key] = rec;
    writeJson(this.indexPath, idx);
    ensureDir(this.peerDir(key));
    return rec;
  }

  touch(key: string, deltaMessages = 1, patch?: Partial<SessionRecord>): void {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    const rec = idx[key];
    if (!rec) return;
    rec.updatedAt = nowIso();
    rec.messageCount += deltaMessages;
    if (patch) Object.assign(rec, patch);
    idx[key] = rec;
    writeJson(this.indexPath, idx);
  }

  setSessionFile(key: string, sessionFile: string, sessionId?: string): void {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    const rec = idx[key];
    if (!rec) return;
    rec.sessionFile = sessionFile;
    if (sessionId) rec.sessionId = sessionId;
    rec.updatedAt = nowIso();
    idx[key] = rec;
    writeJson(this.indexPath, idx);
  }

  reset(key: string): SessionRecord | undefined {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    const rec = idx[key];
    if (!rec) return undefined;
    const next: SessionRecord = {
      ...rec,
      sessionId: uid("sess"),
      sessionFile: undefined,
      updatedAt: nowIso(),
      messageCount: 0,
    };
    idx[key] = next;
    writeJson(this.indexPath, idx);
    // New peer dir generation: bump by writing a marker file id into path via sessionId
    ensureDir(this.peerDir(key, next.sessionId));
    return next;
  }

  delete(key: string): boolean {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    if (!idx[key]) return false;
    delete idx[key];
    writeJson(this.indexPath, idx);
    return true;
  }

  /** Per-peer directory for Pi jsonl sessions. */
  peerDir(key: string, sessionId?: string): string {
    const rec = sessionId ? undefined : this.get(key);
    const sid = sessionId ?? rec?.sessionId ?? "default";
    const safe = hashKey(key, sid);
    const dir = join(this.piSessionsDir, safe);
    ensureDir(dir);
    return dir;
  }

  getPiSessionsDir(): string {
    return this.piSessionsDir;
  }
}
