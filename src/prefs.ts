import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, readJson, writeJson } from "./utils.js";

/** Tool-activity display: off, full (calls + results), or minimal (calls only). */
export type StepsMode = "off" | "on" | "minimal";

/** Per-peer display prefs (Telegram chat / CLI peer). */
export interface PeerPrefs {
  /** Include model reasoning/thinking in the reply */
  showThoughts: boolean;
  /** Tool-call activity: off | on (start+end) | minimal (calls only, no results) */
  showSteps: StepsMode;
  updatedAt?: string;
}

const DEFAULTS: PeerPrefs = {
  showThoughts: false,
  showSteps: "off",
};

/** True when any tool activity should be captured/streamed. */
export function stepsEnabled(mode: StepsMode): boolean {
  return mode === "on" || mode === "minimal";
}

/** Normalize stored/legacy values (boolean true/false → on/off). */
export function normalizeStepsMode(v: unknown): StepsMode {
  if (v === true || v === "on" || v === "full" || v === "true" || v === 1) return "on";
  if (v === "minimal" || v === "min" || v === "calls") return "minimal";
  return "off";
}

function normalizePrefs(raw: Partial<PeerPrefs> & { showSteps?: unknown }): PeerPrefs {
  return {
    showThoughts: Boolean(raw.showThoughts),
    showSteps: normalizeStepsMode(raw.showSteps),
    updatedAt: raw.updatedAt,
  };
}

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
    const all = readJson<Record<string, Partial<PeerPrefs>>>(this.path, {});
    return normalizePrefs({ ...DEFAULTS, ...(all[peerKey] ?? {}) });
  }

  set(peerKey: string, patch: Partial<PeerPrefs>): PeerPrefs {
    const all = readJson<Record<string, Partial<PeerPrefs>>>(this.path, {});
    const next = normalizePrefs({
      ...DEFAULTS,
      ...(all[peerKey] ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    all[peerKey] = next;
    writeJson(this.path, all);
    return next;
  }

  format(p: PeerPrefs): string {
    const stepsLabel =
      p.showSteps === "on" ? "ON" : p.showSteps === "minimal" ? "MINIMAL" : "OFF";
    const stepsHint =
      p.showSteps === "on"
        ? "own msg per tool start/end"
        : p.showSteps === "minimal"
          ? "own msg per tool call (no results)"
          : "hidden";
    return [
      `thoughts (model reasoning): ${p.showThoughts ? "ON" : "OFF"}  — own msg when each thought ends`,
      `steps (tool activity):      ${stepsLabel}  — ${stepsHint}`,
      ``,
      `Toggle: /thoughts on|off   /steps on|off|minimal   /verbose on|off`,
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

/** Parse /steps argument: on | off | minimal. */
export function parseStepsMode(arg: string | undefined): StepsMode | null {
  if (!arg) return null;
  const a = arg.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled", "full"].includes(a)) return "on";
  if (["off", "false", "0", "no", "disable", "disabled"].includes(a)) return "off";
  if (["minimal", "min", "calls"].includes(a)) return "minimal";
  return null;
}

export function formatStepsMode(mode: StepsMode): string {
  if (mode === "on") return "ON";
  if (mode === "minimal") return "MINIMAL";
  return "OFF";
}
