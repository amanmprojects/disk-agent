import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AgentRuntime,
  joinAssistantTextParts,
  normalizeThinkingLevel,
} from "../src/agent/runtime.js";
import { BrowserService } from "../src/browser/service.js";
import type { AppConfig } from "../src/config.js";
import { CronScheduler } from "../src/cron/scheduler.js";
import { Logger } from "../src/logger.js";
import { MemoryStore } from "../src/memory/store.js";
import { SessionRegistry } from "../src/session/manager.js";
import { SkillsStore } from "../src/skills/store.js";
import type { ChannelId, IncomingMessage, LiveProgressEvent } from "../src/types.js";
import { sleep, uid } from "../src/utils.js";
import { makeTestCfg } from "./helpers.js";

/** Minimal stand-in for a Pi AgentSession, driven by test helpers. */
class FakePiSession {
  sessionId: string;
  sessionFile: string;
  model: { provider: string; id: string; contextWindow?: number };
  thinkingLevel: string = "medium";
  disposed = false;
  promptCalls: Array<{ prompt: string; images?: unknown[] }> = [];
  messages: unknown[] = [];
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** Called synchronously inside prompt(); emit stream events here. */
  onPrompt?: (prompt: string) => void;
  private listeners = new Set<(event: unknown) => void>();

  constructor(
    sessionId: string,
    opts?: {
      sessionFile?: string;
      model?: FakePiSession["model"];
      usage?: FakePiSession["usage"];
    },
  ) {
    this.sessionId = sessionId;
    this.sessionFile = opts?.sessionFile ?? `/fake/${sessionId}.jsonl`;
    this.model = opts?.model ?? { provider: "opencode-go", id: "grok-4.5" };
    this.usage = opts?.usage;
  }

  subscribe(fn: (event: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async prompt(prompt: string, opts?: { images?: unknown[] }): Promise<unknown> {
    this.promptCalls.push({ prompt, images: opts?.images });
    if (this.onPrompt) this.onPrompt(prompt);
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  getActiveToolNames(): string[] {
    return ["read", "bash"];
  }

  setActiveToolsByName(): void {
    /* noop */
  }

  getContextUsage() {
    return this.usage;
  }

  getAvailableThinkingLevels(): string[] {
    return ["off", "minimal", "low", "medium", "high", "xhigh"];
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }

  // ── test helpers ────────────────────────────────────────────

  private emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event);
  }

  emitTextDelta(delta: string, contentIndex = 0): void {
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta, contentIndex },
    });
  }

  emitThinkingStart(contentIndex = 0): void {
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex },
    });
  }

  emitThinkingDelta(delta: string, contentIndex = 0): void {
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta, contentIndex },
    });
  }

  emitThinkingEnd(content: string, contentIndex = 0): void {
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content, contentIndex },
    });
  }

  emitToolStart(name: string, id: string, args?: unknown): void {
    this.emit({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
  }

  emitToolEnd(
    name: string,
    id: string,
    opts: { isError?: boolean; error?: string; result?: unknown },
  ): void {
    this.emit({ type: "tool_execution_end", toolName: name, toolCallId: id, ...opts });
  }

  pushAssistantText(text: string): void {
    this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
  }
}

function msg(text: string, channel: ChannelId = "cli", peerId = "local"): IncomingMessage {
  return { id: uid("t"), channel, peerId, text, timestamp: new Date().toISOString() };
}

describe("AgentRuntime", () => {
  let dir: string;
  let cfg: AppConfig;
  let memory: MemoryStore;
  let sessions: SessionRegistry;
  let fakes: FakePiSession[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-agent-runtime-"));
    cfg = makeTestCfg(dir);
    memory = new MemoryStore(cfg);
    sessions = new SessionRegistry(cfg);
    fakes = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a runtime whose sessions come from the fake factory (or a premade fake).
   *  Fakes mimic restored Pi sessions: id adopts the registry sessionId and a
   *  transcript file exists on disk (resume() checks for it). */
  function makeRuntime(premade?: FakePiSession): AgentRuntime {
    const log = new Logger({ level: "error", filePath: join(dir, "logs", "test.log") });
    return new AgentRuntime({
      cfg,
      log,
      memory,
      sessions,
      cron: new CronScheduler(cfg, log),
      browser: new BrowserService(cfg, log),
      skills: new SkillsStore(cfg),
      sessionFactory: async (opts) => {
        const file = join(
          dir,
          "pi-sessions",
          `${opts.channel}_${opts.peerId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`,
        );
        writeFileSync(file, "", "utf8"); // mimic an existing transcript
        const fake = premade ?? new FakePiSession(opts.sessionId);
        fake.sessionId = opts.sessionId;
        fake.sessionFile = file;
        fakes.push(fake);
        return fake as unknown as AgentSession;
      },
    });
  }

  describe("normalizeThinkingLevel", () => {
    it("accepts canonical levels", () => {
      for (const l of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
        assert.equal(normalizeThinkingLevel(l), l);
      }
    });

    it("normalizes case and whitespace", () => {
      assert.equal(normalizeThinkingLevel("  HIGH "), "high");
    });

    it("maps aliases", () => {
      assert.equal(normalizeThinkingLevel("max"), "xhigh");
      assert.equal(normalizeThinkingLevel("none"), "off");
      assert.equal(normalizeThinkingLevel("med"), "medium");
      assert.equal(normalizeThinkingLevel("0"), "off");
      assert.equal(normalizeThinkingLevel("5"), "xhigh");
    });

    it("rejects garbage", () => {
      assert.equal(normalizeThinkingLevel("turbo"), null);
      assert.equal(normalizeThinkingLevel(""), null);
    });
  });

  describe("joinAssistantTextParts", () => {
    it("joins with paragraph breaks to avoid glued sentences", () => {
      assert.equal(joinAssistantTextParts(["now.", "Done"]), "now.\n\nDone");
    });

    it("does not insert a break when whitespace already separates", () => {
      assert.equal(joinAssistantTextParts(["now. ", "Done"]), "now. Done");
      assert.equal(joinAssistantTextParts(["now.", " Done"]), "now. Done");
    });

    it("skips empty parts", () => {
      assert.equal(joinAssistantTextParts(["a", "", "b"]), "a\n\nb");
    });
  });

  describe("run()", () => {
    it("streams text deltas into the result and partials", async () => {
      const fake = new FakePiSession("s1");
      const rt = makeRuntime(fake);
      const partials: string[] = [];
      fake.onPrompt = () => {
        fake.emitTextDelta("Hello ");
        fake.emitTextDelta("world");
      };
      const result = await rt.run(msg("hi"), {
        onPartial: (t) => partials.push(t),
      });
      assert.equal(result.text, "Hello world");
      assert.equal(result.tailText, undefined); // no mid-turn text before tools
      assert.equal(result.error, undefined);
      assert.equal(result.sessionKey, "cli:local");
      assert.ok(result.durationMs >= 0);
      assert.deepEqual(partials, ["Hello ", "Hello world"]);
      assert.equal(fake.promptCalls.length, 1);
      assert.match(fake.promptCalls[0]!.prompt, /\[channel=cli peer=local time=/);
    });

    it("captures thinking blocks and emits progress events", async () => {
      const fake = new FakePiSession("s2");
      const rt = makeRuntime(fake);
      const progress: LiveProgressEvent[] = [];
      fake.onPrompt = () => {
        fake.emitThinkingStart();
        fake.emitThinkingDelta("Let me ");
        fake.emitThinkingDelta("think");
        fake.emitThinkingEnd("Let me think");
        fake.emitTextDelta("Answer.");
      };
      const result = await rt.run(msg("hard question"), {
        onProgress: (ev) => progress.push(ev),
      });
      assert.equal(result.thoughts, "Let me think");
      assert.deepEqual(
        progress.map((ev) => ev.kind),
        ["thinking_start", "thinking_end", "thought"],
      );
      const thought = progress.find((ev) => ev.kind === "thought");
      assert.equal(thought?.kind === "thought" && thought.text, "Let me think");
    });

    it("captures thinking left in the final assistant message", async () => {
      const fake = new FakePiSession("s3");
      const rt = makeRuntime(fake);
      fake.messages.push({ role: "assistant", thinking: "silent reasoning", content: "hi" });
      const result = await rt.run(msg("q"));
      assert.equal(result.thoughts, "silent reasoning");
    });

    it("interleaves tool events: steps, progress, tail text", async () => {
      const fake = new FakePiSession("s4");
      const rt = makeRuntime(fake);
      const progress: LiveProgressEvent[] = [];
      fake.onPrompt = () => {
        fake.emitTextDelta("Checking");
        fake.emitToolStart("bash", "t1", { command: "ls" });
        fake.emitToolEnd("bash", "t1", { result: "a\nb" });
        fake.emitTextDelta("Done.");
      };
      const result = await rt.run(msg("run it"), {
        captureThoughts: false,
        onProgress: (ev) => progress.push(ev),
      });
      assert.equal(result.text, "Checking\n\nDone.");
      assert.equal(result.tailText, "Done.");
      assert.equal(result.toolCalls, 1);
      assert.deepEqual(result.steps, ["→ bash command=ls", "✓ bash — a\nb"]);
      assert.deepEqual(
        progress.map((ev) => ev.kind),
        ["text", "tool_start", "tool_end"],
      );
      const toolEnd = progress.find((ev) => ev.kind === "tool_end");
      assert.ok(toolEnd && toolEnd.kind === "tool_end");
      assert.equal(toolEnd.id, "t1");
      assert.equal(toolEnd.detail, "a\nb");
    });

    it("reports failed tool calls with error detail", async () => {
      const fake = new FakePiSession("s5");
      const rt = makeRuntime(fake);
      fake.onPrompt = () => {
        fake.emitToolStart("read", "t2", { path: "/x" });
        fake.emitToolEnd("read", "t2", { isError: true, error: "ENOENT" });
      };
      const result = await rt.run(msg("read"), { captureThoughts: false });
      assert.ok(result.steps?.[1]?.includes("✗ read"));
      assert.ok(result.steps?.[1]?.includes("ENOENT"));
    });

    it("counts tool calls even when steps are not captured", async () => {
      const fake = new FakePiSession("s6");
      const rt = makeRuntime(fake);
      fake.onPrompt = () => {
        fake.emitToolStart("bash", "t3");
        fake.emitToolEnd("bash", "t3", { result: "ok" });
      };
      const result = await rt.run(msg("x"), { captureSteps: false, captureThoughts: false });
      assert.equal(result.toolCalls, 1);
      assert.equal(result.steps, undefined);
    });

    it("falls back to the last assistant message when nothing streamed", async () => {
      const fake = new FakePiSession("s7");
      const rt = makeRuntime(fake);
      fake.pushAssistantText("full reply");
      const result = await rt.run(msg("q"));
      assert.equal(result.text, "full reply");
    });

    it("returns a graceful error when the model call fails", async () => {
      const fake = new FakePiSession("s8");
      const rt = makeRuntime(fake);
      fake.onPrompt = () => {
        throw new Error("model exploded");
      };
      const result = await rt.run(msg("q"));
      assert.equal(result.error, "model exploded");
      assert.equal(result.text, "Sorry — I hit an error: model exploded");
    });

    it("serializes async stream callbacks in emission order", async () => {
      const fake = new FakePiSession("s9");
      const rt = makeRuntime(fake);
      const order: string[] = [];
      fake.onPrompt = () => {
        fake.emitTextDelta("A");
        fake.emitToolStart("bash", "t1", { command: "ls" });
        fake.emitToolEnd("bash", "t1", { result: "ok" });
        fake.emitThinkingStart();
        fake.emitThinkingDelta("hmm");
        fake.emitThinkingEnd("hmm");
      };
      await rt.run(msg("q"), {
        onProgress: async (ev) => {
          await sleep(2);
          order.push(ev.kind);
        },
      });
      assert.deepEqual(order, [
        "text",
        "tool_start",
        "tool_end",
        "thinking_start",
        "thinking_end",
        "thought",
      ]);
    });

    it("writes a daily log for chat but not for HEARTBEAT cron turns", async () => {
      const rt = makeRuntime();
      await rt.run(msg("hello"));
      const dailyDir = join(cfg.workspaceDir, "memory");
      const count = readdirSync(dailyDir).length;
      assert.ok(count >= 1);

      const rt2 = makeRuntime();
      await rt2.run(msg("HEARTBEAT_OK", "cron", "cron:heartbeat"));
      assert.equal(readdirSync(dailyDir).length, count);
    });

    it("reuses the cached session for a peer", async () => {
      const fake = new FakePiSession("s10");
      const rt = makeRuntime(fake);
      await rt.run(msg("one"));
      await rt.run(msg("two"));
      assert.equal(fakes.length, 1);
      assert.equal(fake.promptCalls.length, 2);
      assert.equal(fake.disposed, false);
    });

    it("never caches ephemeral sessions (heartbeats)", async () => {
      const rt = makeRuntime();
      await rt.run(msg("HEARTBEAT_OK", "cron", "cron:hb"), { ephemeral: true });
      const first = fakes[0]!;
      await rt.run(msg("hi"));
      const second = fakes[1]!;
      assert.notEqual(first, second);
      assert.equal(first.disposed, false);
    });

    it("evicts least-recently-used sessions past the cache cap", async () => {
      const rt = makeRuntime();
      for (let i = 0; i < 33; i++) {
        await rt.run(msg(`msg ${i}`, "cli", `peer${i}`));
      }
      assert.equal(fakes.length, 33);
      assert.equal(fakes[0]!.disposed, true, "oldest session should be evicted");
      assert.equal(fakes[31]!.disposed, false, "newest sessions stay");
    });
  });

  describe("session lifecycle", () => {
    it("resetSession archives and drops the cached session", async () => {
      const rt = makeRuntime();
      await rt.run(msg("hi"));
      const first = fakes[0]!;
      const newId = await rt.resetSession("cli", "local");
      assert.notEqual(newId, first.sessionId);
      assert.equal(first.disposed, true);
      await rt.run(msg("again"));
      assert.equal(fakes.length, 2);
      assert.notEqual(fakes[1], first);
    });

    it("resumeSession drops the cached session for the peer", async () => {
      const rt = makeRuntime();
      await rt.run(msg("hi"));
      const first = fakes[0]!;
      // Archive the current session directly in the registry
      sessions.reset("cli:local");
      const hist = sessions.listHistory("cli:local");
      assert.equal(hist.length, 1);
      const r = await rt.resumeSession(hist[0]!.sessionId, { key: "cli:local" });
      assert.equal(r.ok, true);
      assert.equal(first.disposed, true);
    });

    it("disposeAll disposes every cached session", async () => {
      const rt = makeRuntime();
      await rt.run(msg("a", "cli", "p1"));
      await rt.run(msg("b", "cli", "p2"));
      await rt.disposeAll();
      assert.equal(fakes[0]!.disposed, true);
      assert.equal(fakes[1]!.disposed, true);
    });
  });

  describe("context usage", () => {
    it("reports live session usage when available", async () => {
      const fake = new FakePiSession("s11", {
        model: { provider: "opencode-go", id: "grok-4.5", contextWindow: 4000 },
        usage: { tokens: 400, contextWindow: 4000, percent: 10 },
      });
      const rt = makeRuntime(fake);
      const u = await rt.getContextUsage("cli", "local");
      assert.equal(u.tokens, 400);
      assert.equal(u.contextWindow, 4000);
      assert.equal(u.percent, 10);
      assert.equal(u.model, "opencode-go/grok-4.5");
      assert.equal(u.bar, "[██░░░░░░░░░░░░░░░░░░]");
    });

    it("estimates tokens from messages when usage is unavailable", async () => {
      const fake = new FakePiSession("s12", {
        model: { provider: "opencode-go", id: "grok-4.5", contextWindow: 1000 },
      });
      const rt = makeRuntime(fake);
      fake.messages.push({ role: "assistant", content: [{ type: "text", text: "hello world" }] });
      const u = await rt.getContextUsage("cli", "local");
      assert.ok(u.tokens != null && u.tokens > 0);
      assert.equal(u.contextWindow, 1000);
      assert.match(u.note ?? "", /estimated/);
    });
  });

  describe("thinking effort", () => {
    it("sets the level on the session and persists the config default", async () => {
      const fake = new FakePiSession("s13");
      const rt = makeRuntime(fake);
      const r = await rt.setThinkingEffort("cli", "local", "high", { persist: true });
      assert.equal(r.applied, true);
      assert.equal(r.level, "high");
      assert.equal(cfg.model.thinking, "high");
      assert.equal(fake.thinkingLevel, "high");
    });

    it("normalizes aliases", async () => {
      const rt = makeRuntime();
      const r = await rt.setThinkingEffort("cli", "local", "max");
      assert.equal(r.level, "xhigh");
    });

    it("throws on invalid levels", async () => {
      const rt = makeRuntime();
      await assert.rejects(rt.setThinkingEffort("cli", "local", "turbo"), /Invalid effort level/);
    });

    it("getThinkingEffort reads the cached session, then config", async () => {
      const fake = new FakePiSession("s14");
      const rt = makeRuntime(fake);
      // Don't persist: config stays "medium", session is "high"
      await rt.setThinkingEffort("cli", "local", "high", { persist: false });
      const live = await rt.getThinkingEffort("cli", "local");
      assert.equal(live.level, "high");
      const uncached = await rt.getThinkingEffort("cli", "other");
      assert.equal(uncached.level, "medium");
      assert.equal(uncached.model, "opencode-go/grok-4.5");
    });
  });
});
