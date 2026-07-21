import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, readJson, writeJson } from "./utils.js";

/** Tool-activity display: off, full (calls + results), or minimal (name only). */
export type StepsMode = "off" | "on" | "minimal";

/**
 * Model-reasoning display:
 *  - off: hidden
 *  - on: full thought text when each block finishes
 *  - minimal: italic "Thinking…" only while reasoning tokens stream
 */
export type ThoughtsMode = "off" | "on" | "minimal";

/** Combined verbose shortcut: off | full | minimal indicator mode. */
export type VerboseMode = "off" | "on" | "minimal";

/** Per-peer display prefs (Telegram chat / CLI peer). */
export interface PeerPrefs {
  /** Model reasoning/thinking display */
  showThoughts: ThoughtsMode;
  /** Tool-call activity: off | on (start+end) | minimal (name only) */
  showSteps: StepsMode;
  updatedAt?: string;
}

/** Default = /verbose minimal (Thinking… + tool names only). */
const DEFAULTS: PeerPrefs = {
  showThoughts: "minimal",
  showSteps: "minimal",
};

/** True when any tool activity should be captured/streamed. */
export function stepsEnabled(mode: StepsMode): boolean {
  return mode === "on" || mode === "minimal";
}

/** True when any thought/reasoning activity should be captured. */
export function thoughtsEnabled(mode: ThoughtsMode): boolean {
  return mode === "on" || mode === "minimal";
}

/** Normalize stored/legacy values (boolean true/false → on/off). */
export function normalizeStepsMode(v: unknown): StepsMode {
  if (v === true || v === "on" || v === "full" || v === "true" || v === 1) return "on";
  if (v === "minimal" || v === "min" || v === "calls" || v === "names") return "minimal";
  return "off";
}

/** Normalize thoughts: booleans, on/off/minimal, legacy true → on. */
export function normalizeThoughtsMode(v: unknown): ThoughtsMode {
  if (v === true || v === "on" || v === "full" || v === "true" || v === 1) return "on";
  if (v === "minimal" || v === "min" || v === "indicator" || v === "thinking") return "minimal";
  return "off";
}

function normalizePrefs(
  raw: Partial<PeerPrefs> & { showSteps?: unknown; showThoughts?: unknown },
): PeerPrefs {
  return {
    showThoughts: normalizeThoughtsMode(raw.showThoughts),
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
    const stepsLabel = formatStepsMode(p.showSteps);
    const thoughtsLabel = formatThoughtsMode(p.showThoughts);
    const stepsHint =
      p.showSteps === "on"
        ? "own msg per tool start/end (with args)"
        : p.showSteps === "minimal"
          ? "own msg per tool name only"
          : "hidden";
    const thoughtsHint =
      p.showThoughts === "on"
        ? "own msg when each thought ends"
        : p.showThoughts === "minimal"
          ? 'italic "Thinking…" while reasoning'
          : "hidden";
    return [
      `thoughts (model reasoning): ${thoughtsLabel}  — ${thoughtsHint}`,
      `steps (tool activity):      ${stepsLabel}  — ${stepsHint}`,
      ``,
      `Toggle: /thoughts on|off|minimal   /steps on|off|minimal   /verbose on|off|minimal`,
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
  if (["minimal", "min", "calls", "names"].includes(a)) return "minimal";
  return null;
}

/** Parse /thoughts argument: on | off | minimal. */
export function parseThoughtsMode(arg: string | undefined): ThoughtsMode | null {
  if (!arg) return null;
  const a = arg.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled", "full"].includes(a)) return "on";
  if (["off", "false", "0", "no", "disable", "disabled"].includes(a)) return "off";
  if (["minimal", "min", "indicator", "thinking"].includes(a)) return "minimal";
  return null;
}

/** Parse /verbose argument: on | off | minimal. */
export function parseVerboseMode(arg: string | undefined): VerboseMode | null {
  if (!arg) return null;
  const a = arg.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled", "full"].includes(a)) return "on";
  if (["off", "false", "0", "no", "disable", "disabled"].includes(a)) return "off";
  if (["minimal", "min"].includes(a)) return "minimal";
  return null;
}

/** Map verbose shortcut → concrete thoughts + steps prefs. */
export function prefsForVerbose(mode: VerboseMode): Pick<PeerPrefs, "showThoughts" | "showSteps"> {
  if (mode === "on") return { showThoughts: "on", showSteps: "on" };
  if (mode === "minimal") return { showThoughts: "minimal", showSteps: "minimal" };
  return { showThoughts: "off", showSteps: "off" };
}

export function formatStepsMode(mode: StepsMode): string {
  if (mode === "on") return "ON";
  if (mode === "minimal") return "MINIMAL";
  return "OFF";
}

export function formatThoughtsMode(mode: ThoughtsMode): string {
  if (mode === "on") return "ON";
  if (mode === "minimal") return "MINIMAL";
  return "OFF";
}

export function formatVerboseMode(mode: VerboseMode): string {
  if (mode === "on") return "ON";
  if (mode === "minimal") return "MINIMAL";
  return "OFF";
}

/** Infer combined verbose label from current prefs (best-effort). */
export function inferVerboseMode(p: PeerPrefs): VerboseMode {
  if (p.showThoughts === "on" && p.showSteps === "on") return "on";
  if (p.showThoughts === "minimal" && p.showSteps === "minimal") return "minimal";
  if (p.showThoughts === "off" && p.showSteps === "off") return "off";
  // Mixed custom prefs — not a pure verbose preset
  return "off";
}
