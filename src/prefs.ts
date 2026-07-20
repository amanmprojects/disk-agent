import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, readJson, writeJson } from "./utils.js";

/** Per-peer display prefs (Telegram chat / CLI peer). */
export interface PeerPrefs {
  /** Include model reasoning/thinking in the reply */
  showThoughts: boolean;
  /** Include tool-call activity (name + short args/result) in the reply */
  showSteps: boolean;
  updatedAt?: string;
}

const DEFAULTS: PeerPrefs = {
  showThoughts: false,
  showSteps: false,
};

/**
 * Lightweight JSON prefs store under dataDir/prefs/peers.json
 * Keyed by session key (e.g. telegram:12345).
 */
export class PrefsStore {
  private path: string;

  constructor(cfg: AppConfig) {
    ensureDir(join(cfg.dataDir, "prefs"));
    this.path = join(cfg.dataDir, "prefs", "peers.json");
  }

  get(peerKey: string): PeerPrefs {
    const all = readJson<Record<string, PeerPrefs>>(this.path, {});
    return { ...DEFAULTS, ...(all[peerKey] ?? {}) };
  }

  set(peerKey: string, patch: Partial<PeerPrefs>): PeerPrefs {
    const all = readJson<Record<string, PeerPrefs>>(this.path, {});
    const next: PeerPrefs = {
      ...DEFAULTS,
      ...(all[peerKey] ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    all[peerKey] = next;
    writeJson(this.path, all);
    return next;
  }

  format(p: PeerPrefs): string {
    return [
      `thoughts (model reasoning): ${p.showThoughts ? "ON" : "OFF"}  — own msg when each thought ends`,
      `steps (tool activity):      ${p.showSteps ? "ON" : "OFF"}  — own msg per tool start/end`,
      ``,
      `Toggle: /thoughts on|off   /steps on|off   /verbose on|off`,
    ].join("\n");
  }
}

export function parseOnOff(arg: string | undefined): boolean | null {
  if (!arg) return null;
  const a = arg.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(a)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(a)) return false;
  return null;
}
