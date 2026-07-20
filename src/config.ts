import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import YAML from "yaml";
import { config as loadDotenv } from "dotenv";

const CronDeliverSchema = z.object({
  channel: z.enum(["telegram", "cli", "cron", "system"]).default("telegram"),
  peerId: z.string(),
  chatId: z.string().optional(),
});

export const ConfigSchema = z.object({
  agentName: z.string().default("Disk"),
  workspaceDir: z.string().optional(),
  dataDir: z.string().optional(),
  cwd: z.string().default(process.cwd()),

  model: z
    .object({
      /** Provider id — prefer "supergrok" (pi-supergrok OAuth) or "xai" (API key / built-in OAuth) */
      provider: z.string().default("supergrok"),
      id: z.string().default("grok-4.5"),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
    })
    .default({
      provider: "supergrok",
      id: "grok-4.5",
      thinking: "medium",
    }),

  telegram: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().optional(),
      /** owner_only | allowlist | open (open is discouraged) */
      dmPolicy: z.enum(["owner_only", "allowlist", "open", "pairing"]).default("pairing"),
      allowFrom: z.array(z.string()).default([]),
      ownerId: z.string().optional(),
      /** Require mention in groups */
      groupsRequireMention: z.boolean().default(true),
      /** Stream partial replies as Telegram draft-like edits */
      streamEdits: z.boolean().default(true),
      /** Max chars per Telegram message chunk */
      maxMessageChars: z.number().default(3900),
    })
    .default({
      enabled: false,
      dmPolicy: "pairing",
      allowFrom: [],
      groupsRequireMention: true,
      streamEdits: true,
      maxMessageChars: 3900,
    }),

  memory: z
    .object({
      enabled: z.boolean().default(true),
      maxFacts: z.number().default(200),
      injectUserMd: z.boolean().default(true),
      injectSoulMd: z.boolean().default(true),
      injectMemoryMd: z.boolean().default(true),
      injectDailyLog: z.boolean().default(true),
      dailyLogDays: z.number().default(2),
    })
    .default({
      enabled: true,
      maxFacts: 200,
      injectUserMd: true,
      injectSoulMd: true,
      injectMemoryMd: true,
      injectDailyLog: true,
      dailyLogDays: 2,
    }),

  cron: z
    .object({
      enabled: z.boolean().default(true),
      heartbeat: z
        .object({
          enabled: z.boolean().default(true),
          everyMinutes: z.number().default(30),
          quietHours: z
            .object({
              start: z.number().default(23),
              end: z.number().default(8),
            })
            .default({ start: 23, end: 8 }),
        })
        .default({
          enabled: true,
          everyMinutes: 30,
          quietHours: { start: 23, end: 8 },
        }),
    })
    .default({
      enabled: true,
      heartbeat: {
        enabled: true,
        everyMinutes: 30,
        quietHours: { start: 23, end: 8 },
      },
    }),

  browser: z
    .object({
      enabled: z.boolean().default(true),
      headless: z.boolean().default(true),
      timeoutMs: z.number().default(60_000),
      allowedDomains: z.array(z.string()).default([]),
    })
    .default({
      enabled: true,
      headless: true,
      timeoutMs: 60_000,
      allowedDomains: [],
    }),

  security: z
    .object({
      /** Block dangerous bash patterns unless confirmed (CLI only) */
      bashGuard: z.boolean().default(true),
      blockedPatterns: z
        .array(z.string())
        .default([
          String.raw`\brm\s+-rf\s+/`,
          String.raw`\bmkfs\b`,
          String.raw`:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;`,
          String.raw`\bdd\s+if=`,
        ]),
    })
    .default({
      bashGuard: true,
      blockedPatterns: [
        String.raw`\brm\s+-rf\s+/`,
        String.raw`\bmkfs\b`,
        String.raw`:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;`,
        String.raw`\bdd\s+if=`,
      ],
    }),

  logging: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({ level: "info" }),
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  workspaceDir: string;
  dataDir: string;
};

export function defaultDataDir(): string {
  return join(homedir(), ".disk-agent");
}

export function defaultWorkspaceDir(dataDir: string): string {
  return join(dataDir, "workspace");
}

export function resolvePaths(partial?: {
  dataDir?: string;
  workspaceDir?: string;
}): { dataDir: string; workspaceDir: string } {
  const dataDir = resolve(partial?.dataDir || process.env.DISK_AGENT_HOME || defaultDataDir());
  const workspaceDir = resolve(
    partial?.workspaceDir || process.env.DISK_AGENT_WORKSPACE || defaultWorkspaceDir(dataDir),
  );
  return { dataDir, workspaceDir };
}

export function configPath(dataDir: string): string {
  return join(dataDir, "config.yaml");
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function loadConfig(opts?: {
  dataDir?: string;
  workspaceDir?: string;
  configFile?: string;
}): AppConfig {
  const { dataDir, workspaceDir } = resolvePaths(opts);
  loadDotenv({ path: join(dataDir, ".env"), quiet: true });
  loadDotenv({ quiet: true }); // also project .env

  const file = opts?.configFile || configPath(dataDir);
  let raw: unknown = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    raw = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text) ?? {};
  }

  const parsed = ConfigSchema.parse(raw ?? {});

  // Env overrides
  if (process.env.TELEGRAM_BOT_TOKEN) {
    parsed.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    parsed.telegram.enabled = true;
  }
  if (process.env.DISK_AGENT_OWNER_ID) {
    parsed.telegram.ownerId = process.env.DISK_AGENT_OWNER_ID;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    // presence is enough; pi auth handles keys
  }
  if (process.env.DISK_AGENT_MODEL) {
    const raw = process.env.DISK_AGENT_MODEL.trim();
    if (raw.includes("/")) {
      const [provider, ...rest] = raw.split("/");
      if (provider && rest.length) {
        parsed.model.provider = provider;
        parsed.model.id = rest.join("/");
      }
    } else if (raw) {
      // bare id → keep configured provider (default supergrok)
      parsed.model.id = raw;
    }
  }
  if (process.env.DISK_AGENT_PROVIDER) {
    parsed.model.provider = process.env.DISK_AGENT_PROVIDER;
  }
  if (process.env.DISK_AGENT_CWD) {
    parsed.cwd = resolve(process.env.DISK_AGENT_CWD);
  }

  const cfg: AppConfig = {
    ...parsed,
    dataDir,
    workspaceDir: opts?.workspaceDir || parsed.workspaceDir || workspaceDir,
    cwd: resolve(parsed.cwd),
  };

  return cfg;
}

export function saveConfig(cfg: AppConfig): void {
  ensureDir(cfg.dataDir);
  const { dataDir: _d, workspaceDir: _w, ...serializable } = cfg;
  // Keep paths in file for portability
  const out = {
    ...serializable,
    dataDir: cfg.dataDir,
    workspaceDir: cfg.workspaceDir,
  };
  writeFileSync(configPath(cfg.dataDir), YAML.stringify(out), "utf8");
}

/** Seed workspace identity files if missing (OpenClaw-style). */
export function seedWorkspace(workspaceDir: string, agentName = "Disk"): void {
  ensureDir(workspaceDir);
  ensureDir(join(workspaceDir, "memory"));
  ensureDir(join(workspaceDir, "skills"));
  ensureDir(join(workspaceDir, "knowledge"));

  const files: Record<string, string> = {
    "SOUL.md": `# SOUL.md — Who I Am

I am **${agentName}**, a personal AI agent that lives on the user's machine.

## Personality
- Direct, capable, and warm without being sycophantic
- Prefer action over endless clarification
- Admit uncertainty; never invent facts about the user's life
- Concise in chat channels (Telegram); thorough when coding

## Values
- User privacy and local-first control
- Write important things down (memory files) — sessions end, files persist
- Ask before destructive or irreversible actions
- No surprise side effects on external accounts

## Voice
- Short paragraphs
- Use bullet lists when reporting multi-step work
- Skip corporate filler ("Happy to help!", "Great question!")
`,
    "USER.md": `# USER.md — About the User

<!-- The agent maintains this file. Update it as you learn. -->

## Profile
- Name:
- Timezone:
- Preferred address:

## Preferences
- Communication style:
- Coding stack:
- Do not:

## Active Projects
-

## People & Context
-
`,
    "MEMORY.md": `# MEMORY.md — Long-term Memory

Curated facts the agent should remember across sessions.
Keep this lean. Move ephemeral detail to daily logs under memory/.

## Facts
-

## Preferences
-

## Lessons
-
`,
    "AGENTS.md": `# AGENTS.md — Operating Rules

## Core Loop
1. Read SOUL.md, USER.md, and MEMORY.md when starting non-trivial work.
2. Prefer tools over guesses: read files, run commands, browse when needed.
3. Write durable learnings to MEMORY.md or memory/YYYY-MM-DD.md.
4. For scheduled/heartbeat turns: if nothing needs attention, reply exactly \`HEARTBEAT_OK\`.

## Safety
- Never exfiltrate secrets, .env files, or private keys.
- Do not run destructive commands without explicit user confirmation.
- Respect Telegram allowlists / owner policy.

## Channels
- Telegram replies should be scannable on a phone.
- Use memory tools to persist facts the user asks you to remember.
- Use cron tools for recurring jobs; confirm schedule in plain English.

## Write It Down
Mental notes vanish when the session ends. Files persist. When in doubt, write it down.
`,
    "HEARTBEAT.md": `# HEARTBEAT.md — Proactive Checklist

On each heartbeat, quickly scan:

1. Any overdue cron follow-ups or failed jobs?
2. Anything in MEMORY.md / daily log marked urgent?
3. User-requested monitors (fill in below)

## Monitors
- (none yet)

## Rules
- Respect quiet hours.
- If nothing needs the user, reply exactly: HEARTBEAT_OK
- Keep heartbeat turns cheap — no deep research unless something looks wrong.
`,
    "IDENTITY.md": `# IDENTITY.md

- Name: ${agentName}
- Role: Personal autonomous agent (OpenClaw/Hermes-style)
- Runtime: disk-agent (Pi coding-agent SDK)
- Home: this workspace
`,
  };

  for (const [name, content] of Object.entries(files)) {
    const path = join(workspaceDir, name);
    if (!existsSync(path)) {
      ensureDir(dirname(path));
      writeFileSync(path, content, "utf8");
    }
  }

  // Example skill
  const skillDir = join(workspaceDir, "skills", "remember");
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    ensureDir(skillDir);
    writeFileSync(
      skillFile,
      `---
name: remember
description: Persist user facts and preferences into MEMORY.md / memory tools.
---

# Remember

When the user says "remember that..." or shares a stable preference:

1. Call \`memory_save\` with a clear, atomic fact.
2. Optionally update USER.md if it is profile-level.
3. Confirm briefly what you stored.
`,
      "utf8",
    );
  }
}

export function writeEnvExample(dataDir: string): void {
  ensureDir(dataDir);
  const path = join(dataDir, ".env.example");
  if (existsSync(path)) return;
  writeFileSync(
    path,
    `# Disk Agent environment
# Copy to .env and fill in values

TELEGRAM_BOT_TOKEN=
DISK_AGENT_OWNER_ID=
# Preferred: SuperGrok / X subscription via pi-supergrok OAuth
#   1. pi install npm:pi-supergrok   (or npm i pi-supergrok in this project)
#   2. pi → /login supergrok
# Tokens live in ~/.pi/agent/auth.json (shared with disk-agent)
#
# Or use an xAI API key:
# XAI_API_KEY=
#
# Other providers (optional):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
#
# Model selection (provider/id):
# DISK_AGENT_MODEL=supergrok/grok-4.5
# DISK_AGENT_MODEL=supergrok/grok-4.3
# DISK_AGENT_MODEL=supergrok/grok-composer-2.5-fast
# DISK_AGENT_MODEL=xai/grok-4
# DISK_AGENT_PROVIDER=supergrok
# DISK_AGENT_HOME=~/.disk-agent
# DISK_AGENT_WORKSPACE=~/.disk-agent/workspace
# DISK_AGENT_CWD=
`,
    "utf8",
  );
}

export function bootstrapHome(opts?: { dataDir?: string; workspaceDir?: string; agentName?: string }): AppConfig {
  const paths = resolvePaths(opts);
  ensureDir(paths.dataDir);
  ensureDir(join(paths.dataDir, "sessions"));
  ensureDir(join(paths.dataDir, "cron"));
  ensureDir(join(paths.dataDir, "logs"));
  ensureDir(join(paths.dataDir, "browser"));
  ensureDir(join(paths.dataDir, "pairings"));

  seedWorkspace(paths.workspaceDir, opts?.agentName ?? "Disk");
  writeEnvExample(paths.dataDir);

  let cfg: AppConfig;
  if (!existsSync(configPath(paths.dataDir))) {
    cfg = loadConfig(paths);
    saveConfig(cfg);
  } else {
    cfg = loadConfig(paths);
  }
  return cfg;
}

/** Copy a default config into cwd for repo-local dev */
export function initProjectConfig(cwd = process.cwd()): string {
  const target = join(cwd, "disk-agent.config.yaml");
  if (!existsSync(target)) {
    const sample = `# disk-agent local config (optional — ~/.disk-agent/config.yaml is primary)
agentName: Disk
telegram:
  enabled: false
  dmPolicy: pairing
cron:
  enabled: true
  heartbeat:
    enabled: true
    everyMinutes: 30
browser:
  enabled: true
  headless: true
memory:
  enabled: true
logging:
  level: info
`;
    writeFileSync(target, sample, "utf8");
  }
  return target;
}

export function readTextIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function appendFileLine(path: string, line: string): void {
  ensureDir(dirname(path));
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, prev + line, "utf8");
}

// re-export for convenience
export { copyFileSync, join };
