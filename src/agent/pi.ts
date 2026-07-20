import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.js";

const require = createRequire(import.meta.url);

let runtimePromise: Promise<ModelRuntime> | null = null;
let bootstrapPromise: Promise<void> | null = null;

/** Resolve pi-supergrok extension entry (registers SuperGrok OAuth provider). */
export function resolveSupergrokExtension(): string | null {
  const candidates: string[] = [];
  try {
    const pkgJson = require.resolve("pi-supergrok/package.json");
    candidates.push(join(dirname(pkgJson), "extensions/index.ts"));
  } catch {
    /* not resolvable via require */
  }
  // Common install locations
  candidates.push(
    join(process.cwd(), "node_modules/pi-supergrok/extensions/index.ts"),
    join(getAgentDir(), "npm/node_modules/pi-supergrok/extensions/index.ts"),
    join(
      process.env.HOME || "",
      ".pi/agent/npm/node_modules/pi-supergrok/extensions/index.ts",
    ),
  );
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * Shared ModelRuntime bound to the user's Pi agent dir (~/.pi/agent).
 * This reuses SuperGrok / xAI OAuth tokens from `pi /login` and XAI_API_KEY.
 */
export async function getSharedModelRuntime(log?: Logger): Promise<ModelRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const agentDir = getAgentDir();
      const authPath = join(agentDir, "auth.json");
      const modelsPath = join(agentDir, "models.json");
      const rt = await ModelRuntime.create({
        authPath,
        modelsPath: existsSync(modelsPath) ? modelsPath : null,
      });

      // Optional env overrides (API key path — not needed if OAuth is present)
      if (process.env.XAI_API_KEY) {
        await rt.setRuntimeApiKey("xai", process.env.XAI_API_KEY);
        // Also set on supergrok if provider expects same key style
        try {
          await rt.setRuntimeApiKey("supergrok", process.env.XAI_API_KEY);
        } catch {
          /* provider may not exist yet */
        }
      }
      if (process.env.ANTHROPIC_API_KEY) {
        await rt.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
      }
      if (process.env.OPENAI_API_KEY) {
        await rt.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
      }
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        await rt.setRuntimeApiKey(
          "google",
          process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!,
        );
      }

      log?.debug("ModelRuntime ready", { agentDir, authPath });
      return rt;
    })();
  }
  return runtimePromise;
}

/**
 * Load pi-supergrok so `supergrok` provider + models are registered.
 * Safe to call multiple times.
 */
export async function bootstrapSupergrok(log?: Logger): Promise<{
  loaded: boolean;
  extensionPath: string | null;
  providers: string[];
}> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const modelRuntime = await getSharedModelRuntime(log);
      // Already registered?
      if (modelRuntime.getProvider("supergrok") || modelRuntime.getRegisteredProviderIds().includes("supergrok")) {
        log?.debug("supergrok already registered");
        return;
      }

      const ext = resolveSupergrokExtension();
      if (!ext) {
        log?.warn(
          "pi-supergrok not found. Install with: npm i pi-supergrok  (or pi install npm:pi-supergrok)",
        );
        return;
      }

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.inMemory
        ? SettingsManager.inMemory()
        : SettingsManager.create(process.cwd(), agentDir);

      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
        settingsManager,
        additionalExtensionPaths: [ext],
      });
      await resourceLoader.reload();

      // Creating a short-lived session runs extension factories (registerProvider).
      const { session } = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(),
        tools: [],
        noTools: "all",
      });
      session.dispose();

      // Re-apply XAI key after provider registration if present
      if (process.env.XAI_API_KEY) {
        try {
          await modelRuntime.setRuntimeApiKey("supergrok", process.env.XAI_API_KEY);
        } catch {
          /* ignore */
        }
      }

      log?.info("pi-supergrok loaded", { extension: ext });
    })().catch((err) => {
      // Allow retry on next call
      bootstrapPromise = null;
      throw err;
    });
  }

  await bootstrapPromise;
  const modelRuntime = await getSharedModelRuntime(log);
  return {
    loaded: Boolean(
      modelRuntime.getProvider("supergrok") ||
        modelRuntime.getRegisteredProviderIds().includes("supergrok"),
    ),
    extensionPath: resolveSupergrokExtension(),
    providers: [...modelRuntime.getRegisteredProviderIds()],
  };
}

export type ResolvedModel = {
  provider: string;
  id: string;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
};

/**
 * Resolve a model with SuperGrok-first fallbacks.
 * Accepts "supergrok/grok-4.5", "xai/grok-4", or bare ids.
 */
export async function resolveModel(
  preferred: { provider: string; id: string },
  log?: Logger,
): Promise<ResolvedModel> {
  await bootstrapSupergrok(log);
  const rt = await getSharedModelRuntime(log);

  const tryFind = (provider: string, id: string) => {
    const m = rt.getModel(provider, id);
    if (m) return { provider, id, model: m };
    return null;
  };

  // Exact match
  let hit = tryFind(preferred.provider, preferred.id);
  if (hit) return hit;

  // If user asked for anthropic default but has SuperGrok, prefer it
  const candidates: Array<[string, string]> = [
    [preferred.provider, preferred.id],
    ["supergrok", preferred.id],
    ["supergrok", "grok-4.5"],
    ["supergrok", "grok-4.3"],
    ["supergrok", "grok-4.20-0309-reasoning"],
    ["supergrok", "grok-composer-2.5-fast"],
    ["supergrok", "grok-build-0.1"],
    ["xai", preferred.id],
    ["xai", "grok-4"],
    ["xai", "grok-code-fast-1"],
    ["openai-codex", "gpt-5.4"],
    ["anthropic", "claude-sonnet-4-20250514"],
  ];

  // Prefer models that have auth configured
  for (const [p, id] of candidates) {
    const m = rt.getModel(p, id);
    if (!m) continue;
    if (rt.hasConfiguredAuth(p)) {
      log?.info(`using model ${p}/${id}`);
      return { provider: p, id, model: m };
    }
  }

  // Any available model from async snapshot
  const available = rt.getAvailableSnapshot();
  if (available.length) {
    const m = available[0]!;
    log?.warn(`falling back to available model ${m.provider}/${m.id}`);
    return { provider: m.provider, id: m.id, model: m };
  }

  // Last resort: return unconfigured preferred model object if present in catalog
  for (const [p, id] of candidates) {
    hit = tryFind(p, id);
    if (hit) {
      log?.warn(`model ${p}/${id} found but auth may be missing`);
      return hit;
    }
  }

  const registered = rt.getRegisteredProviderIds().join(", ") || "(none)";
  let creds = "(none)";
  try {
    const list = await rt.listCredentials();
    creds =
      list
        .map((c) => String((c as { providerId?: string; id?: string; provider?: string }).providerId ?? (c as { provider?: string }).provider ?? (c as { id?: string }).id ?? "?"))
        .filter(Boolean)
        .join(", ") || "(none)";
  } catch {
    /* ignore */
  }
  throw new Error(
    [
      `No usable model. Wanted ${preferred.provider}/${preferred.id}.`,
      `Registered providers: ${registered}`,
      `Credentials: ${creds}`,
      ``,
      `Fix one of:`,
      `  1. SuperGrok/X subscription: run \`pi\`, then /login supergrok  (uses ~/.pi/agent/auth.json)`,
      `  2. xAI API key: export XAI_API_KEY=...`,
      `  3. Other key: ANTHROPIC_API_KEY / OPENAI_API_KEY`,
      `  4. Ensure pi-supergrok is installed: npm i pi-supergrok`,
    ].join("\n"),
  );
}

export function piAgentDir(): string {
  return getAgentDir();
}

export type { AgentSession, ModelRuntime };
