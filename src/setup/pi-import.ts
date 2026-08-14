/**
 * Import provider/model info from an existing Pi installation
 * (~/.pi/agent/auth.json, models-store.json, settings.json).
 *
 * Disk Agent shares Pi's credential store, so setup can seed the default
 * model from whatever Pi already has configured — no need to re-type it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piAuthPath, piSettingsPath, resolvePiAgentDir } from "../paths.js";
import { withTimeout } from "../utils.js";

/** One selectable model candidate surfaced from Pi (or a built-in preset). */
export interface PiModelCandidate {
  provider: string;
  id: string;
  /** Provider/model as it appears in config (e.g. "opencode-go/deepseek-v4-flash"). */
  label: string;
  /** Where the candidate came from. */
  source: "pi-default" | "pi-auth" | "pi-catalog" | "preset";
  /** True when Pi has credentials for this provider (auth.json / env). */
  authed: boolean;
}

export interface PiModelInfo {
  candidates: PiModelCandidate[];
  /** Pi's configured default model id (settings.json defaultModel). */
  defaultModel?: string;
  /** Pi's configured default provider (settings.json defaultProvider). */
  defaultProvider?: string;
}

/** Cap on models listed per provider so the wizard stays scannable. */
const MAX_MODELS_PER_PROVIDER = 5;

/** Static presets so the model picker always offers something sane. */
export const MODEL_PRESETS: Array<[string, string]> = [
  ["opencode-go", "grok-4.5"],
  ["opencode-go", "kimi-k2.6"],
  ["opencode", "claude-sonnet-4-5"],
  ["anthropic", "claude-sonnet-4-20250514"],
  ["openai", "gpt-5.4"],
];

interface RawModelsStore {
  [provider: string]: {
    models?: Array<{ id?: string; name?: string }>;
  };
}

/** Provider ids that have credentials in auth.json (keys only — never values). */
export function readPiAuthProviders(authPath: string): string[] {
  try {
    if (!existsSync(authPath)) return [];
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    return Object.keys(raw).filter((k) => typeof raw[k] === "object" && raw[k] !== null);
  } catch {
    return [];
  }
}

/**
 * Parse models-store.json (pi's cached per-provider model catalogs).
 * Returns provider → [{ id, name }]. Tolerant of missing/malformed files.
 */
export function readPiModelsStore(
  modelsPath: string,
): Map<string, Array<{ id: string; name?: string }>> {
  const out = new Map<string, Array<{ id: string; name?: string }>>();
  try {
    if (!existsSync(modelsPath)) return out;
    const raw = JSON.parse(readFileSync(modelsPath, "utf8")) as RawModelsStore;
    for (const [provider, entry] of Object.entries(raw)) {
      const models = entry?.models?.filter((m) => typeof m?.id === "string" && m.id) ?? [];
      if (models.length) out.set(provider, models as Array<{ id: string; name?: string }>);
    }
  } catch {
    /* not parseable — treat as empty */
  }
  return out;
}

/** Pi's configured default provider/model from settings.json. */
export function readPiDefault(settingsPath: string): { provider?: string; model?: string } {
  try {
    if (!existsSync(settingsPath)) return {};
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return {
      provider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
      model: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
    };
  } catch {
    return {};
  }
}

/** Cap on how long ModelRuntime.create may take before the raw-JSON fallback. */
const COLLECT_MODELS_TIMEOUT_MS = 5_000;

/** Options for collectPiModels. */
export interface CollectPiModelsOptions {
  /** Deadline for ModelRuntime.create (default 5s) — on expiry, raw-JSON fallback. */
  timeoutMs?: number;
  /** Test seam: substitute the SDK runtime factory (defaults to ModelRuntime.create). */
  createRuntime?: () => Promise<ModelRuntime>;
}

/**
 * Collect model candidates from an existing Pi install:
 *  1. Pi's configured default provider/model (settings.json) — first.
 *  2. Models of providers that have credentials in auth.json.
 *  3. Other catalogued models (models-store.json).
 *  4. Static presets as a safety net.
 *
 * Prefers the pi SDK (ModelRuntime) for the catalog; falls back to a raw
 * parse of models-store.json when the runtime can't be constructed (e.g.
 * under Node < 26 without FFI) or doesn't answer within the deadline.
 */
export async function collectPiModels(
  agentDir = resolvePiAgentDir(),
  opts: CollectPiModelsOptions = {},
): Promise<PiModelInfo> {
  const authPath = piAuthPath(agentDir);
  const settingsPath = piSettingsPath(agentDir);
  const modelsStorePath = join(agentDir, "models-store.json");

  const authed = new Set(readPiAuthProviders(authPath));
  const piDefault = readPiDefault(settingsPath);

  const candidates: PiModelCandidate[] = [];
  const seen = new Set<string>();
  const push = (provider: string, id: string, source: PiModelCandidate["source"]): void => {
    const key = `${provider}/${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      provider,
      id,
      label: key,
      source,
      authed: authed.has(provider),
    });
  };

  // 1. Pi's configured default.
  if (piDefault.provider && piDefault.model) {
    push(piDefault.provider, piDefault.model, "pi-default");
  }

  // 2+3. Catalog via the SDK when possible (bounded — never hang setup).
  let catalog: Map<string, Array<{ id: string; name?: string }>> | null = null;
  try {
    const rt = await withTimeout(
      opts.createRuntime
        ? opts.createRuntime()
        : ModelRuntime.create({
            authPath,
            modelsPath: modelsStorePath,
            allowModelNetwork: false,
          }),
      opts.timeoutMs ?? COLLECT_MODELS_TIMEOUT_MS,
      "ModelRuntime.create",
    );
    const providers = rt.getRegisteredProviderIds();
    if (providers.length) {
      catalog = new Map();
      for (const provider of providers) {
        const models = rt.getModels(provider).map((m) => ({ id: m.id, name: m.name }));
        if (models.length) catalog.set(provider, models);
      }
    }
  } catch {
    catalog = null;
  }
  if (!catalog) {
    catalog = readPiModelsStore(modelsStorePath);
  }

  if (catalog) {
    for (const [provider, models] of catalog) {
      const source: PiModelCandidate["source"] = authed.has(provider) ? "pi-auth" : "pi-catalog";
      for (const m of models.slice(0, MAX_MODELS_PER_PROVIDER)) {
        push(provider, m.id, source);
      }
    }
  }

  // 4. Presets (deduped; only if pi produced nothing, keep list short).
  if (candidates.length < 3) {
    for (const [provider, id] of MODEL_PRESETS) {
      push(provider, id, "preset");
    }
  }

  return { candidates, defaultModel: piDefault.model, defaultProvider: piDefault.provider };
}
