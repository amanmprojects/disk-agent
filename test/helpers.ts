import { join } from "node:path";
import type { AppConfig } from "../src/config.js";

/**
 * Full-enough AppConfig for constructing gateway/runtime/telegram pieces
 * against an isolated temp dataDir. Sections the code under test touches are
 * populated; the cast covers the rest (same pattern as session.test.ts).
 */
export function makeTestCfg(dataDir: string, overrides?: Partial<AppConfig>): AppConfig {
  const cfg = {
    agentName: "TestAgent",
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
    cwd: dataDir,
    model: { provider: "opencode-go", id: "grok-4.5", thinking: "medium" },
    telegram: {
      enabled: false,
      botToken: undefined,
      dmPolicy: "pairing",
      allowFrom: [] as string[],
      ownerId: undefined,
      groupsRequireMention: true,
      streamEdits: true,
      maxMessageChars: 3900,
    },
    memory: {
      enabled: true,
      maxFacts: 200,
      injectUserMd: true,
      injectSoulMd: true,
      injectMemoryMd: true,
      injectDailyLog: true,
      dailyLogDays: 2,
    },
    cron: {
      enabled: false,
      heartbeat: { enabled: false, everyMinutes: 30, quietHours: { start: 23, end: 8 } },
    },
    browser: {
      enabled: false,
      headless: true,
      timeoutMs: 60_000,
      allowedDomains: [] as string[],
    },
    security: { bashGuard: true, blockedPatterns: [] as string[] },
    logging: { level: "error" },
    voice: { enabled: false, provider: "none" },
  } as AppConfig;
  return overrides ? ({ ...cfg, ...overrides } as AppConfig) : cfg;
}
