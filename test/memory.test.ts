import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapHome, loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory/store.js";
import { CronScheduler, normalizeSchedule, describeSchedule } from "../src/cron/scheduler.js";
import { Logger } from "../src/logger.js";
import { chunkText, inQuietHours, KeyedQueue } from "../src/utils.js";
import { SessionRegistry, makeSessionKey } from "../src/session/manager.js";

describe("memory store", () => {
  const dir = mkdtempSync(join(tmpdir(), "disk-agent-test-"));
  const cfg = bootstrapHome({ dataDir: dir, agentName: "TestBot" });
  const mem = new MemoryStore(cfg);

  it("saves and searches facts", () => {
    mem.saveFact({ content: "User timezone is IST", kind: "preference", tags: ["tz"] });
    mem.saveFact({ content: "Working on disk-agent", kind: "project" });
    const hits = mem.search("timezone");
    assert.ok(hits.some((h) => h.content.includes("IST")));
  });

  it("writes daily log", () => {
    const path = mem.appendDailyLog("tested daily log");
    assert.ok(path.endsWith(".md"));
    const recent = mem.readRecentDailyLogs(1);
    assert.ok(recent.includes("tested daily log"));
  });

  it("builds bootstrap context", () => {
    const ctx = mem.buildBootstrapContext(cfg);
    assert.ok(ctx.includes("SOUL.md"));
    assert.ok(ctx.includes("TestBot") || ctx.includes("Who I Am") || ctx.length > 50);
  });

  // cleanup last
  it("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cron schedule parsing", () => {
  it("parses every", () => {
    const s = normalizeSchedule("every 30m");
    assert.equal(s.kind, "every");
    if (s.kind === "every") assert.equal(s.everyMs, 30 * 60_000);
  });

  it("parses daily at", () => {
    const s = normalizeSchedule("daily at 09:30");
    assert.equal(s.kind, "cron");
    if (s.kind === "cron") assert.equal(s.expr, "30 9 * * *");
  });

  it("parses cron expr", () => {
    const s = normalizeSchedule("0 */2 * * *");
    assert.equal(s.kind, "cron");
  });

  it("describe", () => {
    assert.ok(describeSchedule({ kind: "cron", expr: "0 9 * * *" }).includes("0 9"));
  });
});

describe("cron scheduler persistence", () => {
  it("adds and lists jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-agent-cron-"));
    const cfg = bootstrapHome({ dataDir: dir });
    cfg.cron.heartbeat.enabled = false;
    const log = new Logger({ level: "error" });
    const cron = new CronScheduler(cfg, log);
    const job = cron.add({
      name: "t",
      schedule: "every 5m",
      prompt: "hi",
      deliver: { channel: "cli", peerId: "local" },
    });
    assert.equal(cron.list().length, 1);
    assert.ok(cron.get(job.id));
    assert.ok(cron.remove(job.id));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("utils", () => {
  it("chunks long text", () => {
    const parts = chunkText("a".repeat(5000), 1000);
    assert.ok(parts.length >= 5);
    assert.ok(parts.every((p) => p.length <= 1000));
  });

  it("quiet hours wrap", () => {
    // 23-8 wraps midnight
    const night = new Date();
    night.setHours(1, 0, 0, 0);
    assert.equal(inQuietHours(23, 8, night), true);
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    assert.equal(inQuietHours(23, 8, noon), false);
  });

  it("keyed queue serializes", async () => {
    const q = new KeyedQueue();
    const order: number[] = [];
    await Promise.all([
      q.run("a", async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
      }),
      q.run("a", async () => {
        order.push(2);
      }),
    ]);
    assert.deepEqual(order, [1, 2]);
  });
});

describe("sessions", () => {
  it("creates and resets", () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-agent-sess-"));
    const cfg = loadConfig({ dataDir: dir });
    bootstrapHome({ dataDir: dir });
    const reg = new SessionRegistry(cfg);
    const a = reg.getOrCreate("telegram", "42", "alice");
    assert.equal(a.key, makeSessionKey("telegram", "42"));
    const b = reg.getOrCreate("telegram", "42");
    assert.equal(a.sessionId, b.sessionId);
    const reset = reg.reset(a.key)!;
    assert.notEqual(reset.sessionId, a.sessionId);
    rmSync(dir, { recursive: true, force: true });
  });
});
