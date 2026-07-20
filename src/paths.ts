/**
 * Canonical on-disk layout for Disk Agent.
 *
 * Everything owned by disk-agent lives under a single home root:
 *
 *   $DISK_AGENT_HOME
 *   or $XDG_DATA_HOME/disk-agent
 *   or ~/.disk-agent
 *
 * Layout:
 *
 *   home/
 *   ├── config.yaml
 *   ├── .env / .env.example
 *   ├── workspace/              identity + memory + workspace skills
 *   │   ├── SOUL.md USER.md MEMORY.md AGENTS.md HEARTBEAT.md IDENTITY.md
 *   │   ├── memory/YYYY-MM-DD.md
 *   │   ├── knowledge/
 *   │   └── skills/<name>/SKILL.md
 *   ├── skills/                 user-global skills (default scope=user)
 *   ├── sessions/               logical session index
 *   ├── pi-sessions/            Pi jsonl transcripts
 *   ├── cron/jobs.json
 *   ├── memory/facts.json
 *   ├── pairings/
 *   ├── browser/
 *   ├── media/
 *   ├── prefs/
 *   └── logs/gateway.log
 *
 * Auth is intentionally shared with Pi at ~/.pi/agent (auth.json), not under home.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Package / product name used in paths and messages. */
export const PRODUCT_NAME = "disk-agent";

/** Directory basename under XDG_DATA_HOME or $HOME. */
export const HOME_DIR_NAME = ".disk-agent";

export interface DiskAgentPaths {
  /** Root data directory (config, sessions, runtime state). */
  home: string;
  /** Agent identity, markdown memory, workspace skills. */
  workspace: string;
  /** User-global skills under home (standardized). */
  userSkills: string;
  /** Workspace-scoped skills. */
  workspaceSkills: string;
  /** Project skills relative to a coding cwd: <cwd>/.agents/skills */
  projectSkills: (cwd: string) => string;
  configFile: string;
  envFile: string;
  envExampleFile: string;
  sessions: string;
  piSessions: string;
  cron: string;
  cronJobs: string;
  memoryFacts: string;
  pairings: string;
  browser: string;
  media: string;
  prefs: string;
  logs: string;
  gatewayLog: string;
  workspaceMemory: string;
  workspaceKnowledge: string;
}

/**
 * Resolve the disk-agent home directory.
 * Priority: explicit arg → DISK_AGENT_HOME → XDG_DATA_HOME/disk-agent → ~/.disk-agent
 */
export function resolveHomeDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.DISK_AGENT_HOME) return resolve(process.env.DISK_AGENT_HOME);

  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return resolve(xdg, PRODUCT_NAME);

  return join(homedir(), HOME_DIR_NAME);
}

/**
 * Resolve workspace directory.
 * Priority: explicit → DISK_AGENT_WORKSPACE → <home>/workspace
 */
export function resolveWorkspaceDir(home: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.DISK_AGENT_WORKSPACE) return resolve(process.env.DISK_AGENT_WORKSPACE);
  return join(home, "workspace");
}

/** Build the full standardized path map for a home (+ optional workspace override). */
export function getPaths(opts?: {
  home?: string;
  workspace?: string;
}): DiskAgentPaths {
  const home = resolveHomeDir(opts?.home);
  const workspace = resolveWorkspaceDir(home, opts?.workspace);

  return {
    home,
    workspace,
    userSkills: join(home, "skills"),
    workspaceSkills: join(workspace, "skills"),
    projectSkills: (cwd: string) => join(cwd, ".agents", "skills"),
    configFile: join(home, "config.yaml"),
    envFile: join(home, ".env"),
    envExampleFile: join(home, ".env.example"),
    sessions: join(home, "sessions"),
    piSessions: join(home, "pi-sessions"),
    cron: join(home, "cron"),
    cronJobs: join(home, "cron", "jobs.json"),
    memoryFacts: join(home, "memory", "facts.json"),
    pairings: join(home, "pairings"),
    browser: join(home, "browser"),
    media: join(home, "media"),
    prefs: join(home, "prefs"),
    logs: join(home, "logs"),
    gatewayLog: join(home, "logs", "gateway.log"),
    workspaceMemory: join(workspace, "memory"),
    workspaceKnowledge: join(workspace, "knowledge"),
  };
}

/** Create all standard runtime directories under home + workspace. */
export function ensureLayout(paths: DiskAgentPaths): void {
  const dirs = [
    paths.home,
    paths.workspace,
    paths.userSkills,
    paths.workspaceSkills,
    paths.workspaceMemory,
    paths.workspaceKnowledge,
    paths.sessions,
    paths.piSessions,
    paths.cron,
    join(paths.home, "memory"),
    paths.pairings,
    paths.browser,
    paths.media,
    paths.prefs,
    paths.logs,
  ];
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** Human-readable tree of the layout (for setup / doctor output). */
export function describeLayout(paths: DiskAgentPaths): string {
  return [
    `${paths.home}/`,
    `├── config.yaml`,
    `├── .env`,
    `├── workspace/          # identity, MEMORY.md, daily logs, workspace skills`,
    `│   ├── skills/`,
    `│   ├── memory/`,
    `│   └── knowledge/`,
    `├── skills/            # user-global skills`,
    `├── sessions/`,
    `├── pi-sessions/`,
    `├── cron/`,
    `├── memory/            # structured facts.json`,
    `├── pairings/`,
    `├── browser/`,
    `├── media/`,
    `├── prefs/`,
    `└── logs/`,
  ].join("\n");
}

// ── Pi agent directory (auth / packages / extensions) ──────────────────────

/** Pi's agent dir (~/.pi/agent). Auth tokens live here, shared with `pi` CLI. */
export function resolvePiAgentDir(): string {
  if (process.env.PI_AGENT_DIR) return resolve(process.env.PI_AGENT_DIR);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  // Pi itself uses ~/.pi/agent via getAgentDir(); we mirror for setup writes.
  // Prefer HOME/.pi/agent for compatibility with pi-coding-agent defaults.
  void xdg;
  return join(homedir(), ".pi", "agent");
}

export function piSettingsPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "settings.json");
}

export function piAuthPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "auth.json");
}

export function piPackagesDir(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "npm", "node_modules");
}
