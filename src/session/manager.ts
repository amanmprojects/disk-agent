import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type {
  ChannelId,
  SessionHistoryEntry,
  SessionLookup,
  SessionRecord,
} from "../types.js";
import { ensureDir, hashKey, nowIso, readJson, uid, writeJson } from "../utils.js";

const MAX_HISTORY = 50;

export function makeSessionKey(channel: ChannelId, peerId: string): string {
  return `${channel}:${peerId}`;
}

function isArchivable(rec: SessionRecord): boolean {
  return Boolean(rec.sessionFile) || rec.messageCount > 0;
}

function toHistoryEntry(rec: SessionRecord, archivedAt = nowIso()): SessionHistoryEntry {
  return {
    sessionId: rec.sessionId,
    sessionFile: rec.sessionFile,
    title: rec.title,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    messageCount: rec.messageCount,
    archivedAt,
  };
}

function pushHistory(rec: SessionRecord, entry: SessionHistoryEntry): void {
  const hist = rec.history ?? [];
  // Drop any prior entry with the same sessionId (re-archive after resume)
  const filtered = hist.filter((h) => h.sessionId !== entry.sessionId);
  filtered.unshift(entry);
  rec.history = filtered.slice(0, MAX_HISTORY);
}

/**
 * Tracks logical conversation sessions and maps them to Pi SessionManager files.
 * One lane per (channel, peer) — serialized by the gateway queue.
 *
 * Each peer gets its own Pi session directory so continueRecent() is peer-scoped.
 * On reset, the previous transcript is archived in `history` so it can be listed and resumed.
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
      history: [],
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
    if (isArchivable(rec)) {
      pushHistory(rec, toHistoryEntry(rec));
    }
    const next: SessionRecord = {
      ...rec,
      sessionId: uid("sess"),
      sessionFile: undefined,
      updatedAt: nowIso(),
      messageCount: 0,
      history: rec.history ?? [],
    };
    idx[key] = next;
    writeJson(this.indexPath, idx);
    // New peer dir generation: bump by writing a marker file id into path via sessionId
    ensureDir(this.peerDir(key, next.sessionId));
    return next;
  }

  /**
   * Resume a previous (or still-active) session for a peer.
   * Archives the current active transcript first when switching away from it.
   */
  resume(key: string, sessionIdOrPath: string): { ok: true; rec: SessionRecord } | { ok: false; error: string } {
    const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
    const rec = idx[key];
    if (!rec) return { ok: false, error: `Unknown session key ${key}` };

    const needle = sessionIdOrPath.trim();
    if (!needle) return { ok: false, error: "Missing session id or path" };

    // Already active?
    if (this.matchesId(rec.sessionId, needle) || (rec.sessionFile && this.matchesPath(rec.sessionFile, needle))) {
      return { ok: true, rec };
    }

    const hist = rec.history ?? [];
    const foundIdx = hist.findIndex(
      (h) =>
        this.matchesId(h.sessionId, needle) ||
        (h.sessionFile && this.matchesPath(h.sessionFile, needle)),
    );
    if (foundIdx < 0) {
      return {
        ok: false,
        error: `No archived session matching "${needle}" for ${key}. Try: disk-agent sessions history ${key}`,
      };
    }

    const target = hist[foundIdx]!;
    if (target.sessionFile && !existsSync(target.sessionFile)) {
      return { ok: false, error: `Session file missing: ${target.sessionFile}` };
    }

    // Archive current if it has content
    if (isArchivable(rec)) {
      pushHistory(rec, toHistoryEntry(rec));
    }
    // Remove the target from history (it's becoming active)
    rec.history = (rec.history ?? []).filter((h) => h.sessionId !== target.sessionId);

    rec.sessionId = target.sessionId;
    rec.sessionFile = target.sessionFile;
    rec.title = target.title ?? rec.title;
    rec.createdAt = target.createdAt;
    rec.updatedAt = nowIso();
    rec.messageCount = target.messageCount;

    idx[key] = rec;
    writeJson(this.indexPath, idx);
    return { ok: true, rec };
  }

  /**
   * Resume by session id/path, discovering the peer key if not given.
   * Prefer an explicit key when the same id could theoretically collide (unlikely).
   */
  resumeById(
    sessionIdOrPath: string,
    preferredKey?: string,
  ): { ok: true; rec: SessionRecord } | { ok: false; error: string } {
    const matches = this.find(sessionIdOrPath);
    if (!matches.length) {
      // Allow resuming a raw jsonl path into preferredKey (or cli:local)
      if (sessionIdOrPath.includes("/") || sessionIdOrPath.endsWith(".jsonl")) {
        const path = sessionIdOrPath;
        if (!existsSync(path)) {
          return { ok: false, error: `Session file not found: ${path}` };
        }
        const key = preferredKey ?? "cli:local";
        const parts = key.split(":");
        const channel = (parts[0] ?? "cli") as ChannelId;
        const peerId = parts.slice(1).join(":") || "local";
        this.getOrCreate(channel, peerId);
        // Inject into history then resume
        const idx = readJson<Record<string, SessionRecord>>(this.indexPath, {});
        const rec = idx[key];
        if (!rec) return { ok: false, error: `Could not create peer ${key}` };
        const sid = this.sessionIdFromPath(path) ?? uid("sess");
        pushHistory(rec, {
          sessionId: sid,
          sessionFile: path,
          title: rec.title,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          messageCount: 0,
          archivedAt: nowIso(),
        });
        idx[key] = rec;
        writeJson(this.indexPath, idx);
        return this.resume(key, sid);
      }
      return {
        ok: false,
        error: `No session matching "${sessionIdOrPath}". Run: disk-agent sessions list`,
      };
    }

    if (preferredKey) {
      const hit = matches.find((m) => m.key === preferredKey);
      if (!hit) {
        return {
          ok: false,
          error: `Session "${sessionIdOrPath}" is not under ${preferredKey} (found under ${matches.map((m) => m.key).join(", ")})`,
        };
      }
      return this.resume(preferredKey, hit.sessionId);
    }

    if (matches.length > 1) {
      const actives = matches.filter((m) => m.active);
      if (actives.length === 1) {
        return this.resume(actives[0]!.key, actives[0]!.sessionId);
      }
      return {
        ok: false,
        error:
          `Ambiguous session id — matches:\n` +
          matches.map((m) => `  ${m.sessionId}  ${m.key}  ${m.active ? "(active)" : "(archived)"}`).join("\n") +
          `\nPass --key <peer> to disambiguate.`,
      };
    }

    const only = matches[0]!;
    return this.resume(only.key, only.sessionId);
  }

  /** List archived transcripts (optionally for one peer). Most recent first. */
  listHistory(key?: string): Array<SessionLookup> {
    const out: SessionLookup[] = [];
    const records = key ? [this.get(key)].filter(Boolean) as SessionRecord[] : this.list();
    for (const rec of records) {
      for (const h of rec.history ?? []) {
        out.push({
          key: rec.key,
          channel: rec.channel,
          peerId: rec.peerId,
          sessionId: h.sessionId,
          sessionFile: h.sessionFile,
          title: h.title,
          createdAt: h.createdAt,
          updatedAt: h.updatedAt,
          messageCount: h.messageCount,
          active: false,
          archivedAt: h.archivedAt,
        });
      }
    }
    out.sort((a, b) => (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt));
    return out;
  }

  /**
   * Find sessions by full/partial id or session file path across active + history.
   */
  find(sessionIdOrPath: string): SessionLookup[] {
    const needle = sessionIdOrPath.trim();
    if (!needle) return [];
    const out: SessionLookup[] = [];
    for (const rec of this.list()) {
      if (this.matchesId(rec.sessionId, needle) || (rec.sessionFile && this.matchesPath(rec.sessionFile, needle))) {
        out.push({
          key: rec.key,
          channel: rec.channel,
          peerId: rec.peerId,
          sessionId: rec.sessionId,
          sessionFile: rec.sessionFile,
          title: rec.title,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          messageCount: rec.messageCount,
          active: true,
        });
      }
      for (const h of rec.history ?? []) {
        if (this.matchesId(h.sessionId, needle) || (h.sessionFile && this.matchesPath(h.sessionFile, needle))) {
          out.push({
            key: rec.key,
            channel: rec.channel,
            peerId: rec.peerId,
            sessionId: h.sessionId,
            sessionFile: h.sessionFile,
            title: h.title,
            createdAt: h.createdAt,
            updatedAt: h.updatedAt,
            messageCount: h.messageCount,
            active: false,
            archivedAt: h.archivedAt,
          });
        }
      }
    }
    return out;
  }

  /**
   * Scan pi-sessions/ for .jsonl transcripts not necessarily in the index.
   * Useful for recovering orphans from before history tracking existed.
   */
  listTranscriptFiles(): Array<{ path: string; sessionId: string; mtime: string; size: number }> {
    const out: Array<{ path: string; sessionId: string; mtime: string; size: number }> = [];
    if (!existsSync(this.piSessionsDir)) return out;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.piSessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(this.piSessionsDir, d.name));
    } catch {
      return out;
    }
    for (const dir of dirs) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(dir, f);
        try {
          const st = statSync(path);
          out.push({
            path,
            sessionId: this.sessionIdFromPath(path) ?? f.replace(/\.jsonl$/, ""),
            mtime: new Date(st.mtimeMs).toISOString(),
            size: st.size,
          });
        } catch {
          /* skip */
        }
      }
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return out;
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

  private matchesId(sessionId: string, needle: string): boolean {
    if (sessionId === needle) return true;
    // Prefix match (short ids) — require at least 6 chars to avoid accidental hits
    if (needle.length >= 6 && sessionId.startsWith(needle)) return true;
    // Also allow matching the uuid suffix after sess_ prefix
    if (sessionId.includes(needle) && needle.length >= 8) return true;
    return false;
  }

  private matchesPath(sessionFile: string, needle: string): boolean {
    if (sessionFile === needle) return true;
    if (sessionFile.endsWith(needle)) return true;
    return false;
  }

  private sessionIdFromPath(path: string): string | undefined {
    // Filenames look like: 2026-07-21T09-57-40-828Z_019f841c-155c-77b5-93ab-0e7fdbc0f439.jsonl
    const base = path.split(/[/\\]/).pop() ?? "";
    const m = base.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) return m[1];
    const m2 = base.match(/_(sess_[a-f0-9]+)\.jsonl$/i);
    if (m2) return m2[1];
    return undefined;
  }
}
