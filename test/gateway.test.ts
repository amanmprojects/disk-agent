import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  formatCronHtml,
  formatFinalHtml,
  formatToolDoneHtml,
  formatToolRunningHtml,
} from "../src/format/telegram.js";
import { type AgentLike, Gateway, type TelegramLike } from "../src/gateway.js";
import type {
  AgentRunResult,
  CronJob,
  IncomingMessage,
  LiveProgressEvent,
  OutgoingMessage,
  PairingRequest,
} from "../src/types.js";
import { sleep, uid } from "../src/utils.js";
import { makeTestCfg } from "./helpers.js";

function msg(
  text: string,
  channel: "telegram" | "cli" | "cron" = "cli",
  peerId = "local",
  chatId?: string,
): IncomingMessage {
  return { id: uid("t"), channel, peerId, chatId, text, timestamp: new Date().toISOString() };
}

function cronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job1",
    name: "morning-brief",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    prompt: "brief me",
    deliver: { channel: "telegram", peerId: "telegram:42", chatId: "42" },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

/** In-memory stand-in for AgentRuntime (gateway only ever talks through AgentLike). */
class FakeAgent {
  runResult: AgentRunResult = { text: "ok", sessionKey: "cli:local", toolCalls: 0, durationMs: 5 };
  onRun?: (msg: IncomingMessage, opts?: unknown) => AgentRunResult | Promise<AgentRunResult>;
  runCalls: Array<{ msg: IncomingMessage; opts?: unknown }> = [];
  resetCalls = 0;
  resumeCalls: Array<{ id: string; opts?: unknown }> = [];
  disposed = false;
  usage = {
    tokens: 123,
    contextWindow: 4000,
    percent: 3.075,
    model: "opencode-go/grok-4.5",
    messageCount: 5,
    sessionKey: "cli:local",
    bar: "[██░░░░░░░░░░░░░░░░░░]",
  };
  effort = {
    level: "medium",
    available: ["off", "minimal", "low", "medium", "high", "xhigh"],
    model: "opencode-go/grok-4.5",
  };

  async run(msgIn: IncomingMessage, opts?: unknown): Promise<AgentRunResult> {
    this.runCalls.push({ msg: msgIn, opts });
    if (this.onRun) return this.onRun(msgIn, opts);
    return this.runResult;
  }

  async resetSession(): Promise<string> {
    this.resetCalls += 1;
    return "sess-new";
  }

  async resumeSession(id: string, opts?: unknown) {
    this.resumeCalls.push({ id, opts });
    return { ok: true, key: "cli:local", sessionId: id };
  }

  async getContextUsage() {
    return this.usage;
  }

  async getThinkingEffort() {
    return this.effort;
  }

  async setThinkingEffort(_c: string, _p: string, level: string) {
    return { level, available: this.effort.available, applied: true, model: this.effort.model };
  }

  async ensureReady() {}

  async listModels() {
    return [{ provider: "opencode-go", id: "grok-4.5", auth: true }];
  }

  async disposeAll() {
    this.disposed = true;
  }
}

/** In-memory stand-in for TelegramChannel. */
class FakeTelegram {
  sent: OutgoingMessage[] = [];
  deleted: Array<{ chatId: string; messageId: number }> = [];
  typingCalls: string[] = [];
  handler?: (m: IncomingMessage) => Promise<void>;
  pending: PairingRequest[] = [];
  approveResult: { ok: boolean; userId?: string; error?: string } = { ok: true, userId: "99" };
  started = false;
  private nextId = 100;

  onMessage(h: (m: IncomingMessage) => Promise<void>): void {
    this.handler = h;
  }

  isEnabled(): boolean {
    return true;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async send(out: OutgoingMessage): Promise<number | undefined> {
    this.sent.push(out);
    return out.editMessageId != null ? Number(out.editMessageId) : this.nextId++;
  }

  async typing(chatId: string): Promise<void> {
    this.typingCalls.push(chatId);
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }

  listPendingPairings(): PairingRequest[] {
    return this.pending;
  }

  async approvePairing(): Promise<{ ok: boolean; userId?: string; error?: string }> {
    return this.approveResult;
  }
}

function progressOf(opts?: unknown): (ev: LiveProgressEvent) => void | Promise<void> {
  return (
    (opts as { onProgress?: (ev: LiveProgressEvent) => void | Promise<void> })?.onProgress ??
    (() => {})
  );
}

describe("Gateway", () => {
  let dir: string;
  let agent: FakeAgent;
  let tg: FakeTelegram;
  let gw: Gateway;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-agent-gw-"));
    agent = new FakeAgent();
    tg = new FakeTelegram();
    gw = new Gateway(makeTestCfg(dir), {
      agent: agent as unknown as AgentLike,
      telegram: tg as unknown as TelegramLike,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Capture console.log (CLI channel delivery target) for the duration of fn. */
  async function withLog(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (line?: unknown) => lines.push(String(line));
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return lines;
  }

  describe("slash commands", () => {
    it("/help returns the command list", async () => {
      const r = await gw.handleIncoming(msg("/help"));
      assert.ok(r.includes("TestAgent"));
      assert.ok(r.includes("/help"));
    });

    it("/whoami echoes channel and peer", async () => {
      const r = await gw.handleIncoming(msg("/whoami"));
      assert.ok(r.includes("channel: cli"));
      assert.ok(r.includes("peerId: local"));
    });

    it("/remember + /memory round-trips facts through the real store", async () => {
      const saved = await gw.handleIncoming(msg("/remember I prefer short replies"));
      assert.match(saved, /Saved/);
      const list = await gw.handleIncoming(msg("/memory"));
      assert.ok(list.includes("I prefer short replies"));
      const hit = await gw.handleIncoming(msg("/memory search short"));
      assert.ok(hit.includes("I prefer short replies"));
      const miss = await gw.handleIncoming(msg("/memory search zzzz"));
      assert.match(miss, /No matches/);
    });

    it("prefs commands update per-peer display settings", async () => {
      const r = await gw.handleIncoming(msg("/thoughts on"));
      assert.match(r, /Thoughts ON/);
      const v = await gw.handleIncoming(msg("/verbose on"));
      assert.match(v, /Verbose ON/);
      const p = await gw.handleIncoming(msg("/prefs"));
      assert.ok(p.includes("thoughts (model reasoning): ON"));
      assert.ok(p.includes("steps (tool activity):      ON"));
      const off = await gw.handleIncoming(msg("/steps off"));
      assert.match(off, /Steps OFF/);
    });

    it("/new resets the agent session", async () => {
      const r = await gw.handleIncoming(msg("/new"));
      assert.match(r, /New session started \(sess-new\)/);
      assert.equal(agent.resetCalls, 1);
    });

    it("/sessions lists the active session", async () => {
      const r = await gw.handleIncoming(msg("/sessions"));
      assert.ok(r.includes("Sessions for cli:local"));
      assert.match(r, /Active:/);
    });

    it("/status reports gateway state", async () => {
      const r = await gw.handleIncoming(msg("/status"));
      assert.ok(r.includes("sessions: 0"));
      assert.ok(r.includes("cron jobs: 0"));
      assert.ok(r.includes("memory facts: 0"));
      assert.ok(r.includes("telegram: enabled"));
      assert.ok(r.includes("browser: fetch-only"));
      assert.match(r, /tools: \d+/);
    });

    it("/context renders usage from the agent", async () => {
      const r = await gw.handleIncoming(msg("/context"));
      assert.ok(r.includes("Context window"));
      assert.ok(r.includes("123 / 4,000"));
      assert.ok(r.includes("session: cli:local"));
    });

    it("/effort reads and sets thinking level, persisting config", async () => {
      const cur = await gw.handleIncoming(msg("/effort"));
      assert.match(cur, /Thinking effort: \*\*medium\*\*/);
      const set = await gw.handleIncoming(msg("/effort high"));
      assert.match(set, /Thinking effort set to \*\*high\*\*/);
      assert.ok(existsSync(join(dir, "config.yaml")), "config default should be saved");
    });

    it("/model updates config and disposes cached sessions", async () => {
      const r = await gw.handleIncoming(msg("/model opencode-go/grok-4.5"));
      assert.match(r, /Model set to opencode-go\/grok-4.5 \(saved\)/);
      assert.equal(agent.disposed, true);
      const bare = await gw.handleIncoming(msg("/model"));
      assert.match(bare, /Current model: opencode-go\/grok-4.5/);
    });

    it("/tools lists the allowlist by category", async () => {
      const r = await gw.handleIncoming(msg("/tools"));
      assert.match(r, /Agent tools \(\d+\):/);
      assert.ok(r.includes("coding:"));
      assert.ok(r.includes("web:"));
    });

    it("/cron reports no jobs in a fresh store", async () => {
      const r = await gw.handleIncoming(msg("/cron"));
      assert.match(r, /No cron jobs/);
    });

    it("/browser reports the CLI status", async () => {
      const r = await gw.handleIncoming(msg("/browser"));
      assert.match(r, /Browser: CLI missing/);
    });

    it("/pair lists pending pairing codes", async () => {
      tg.pending = [
        {
          code: "AB12CD34",
          userId: "9",
          username: "alice",
          createdAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ];
      const r = await gw.handleIncoming(msg("/pair"));
      assert.ok(r.includes("AB12CD34"));
      assert.ok(r.includes("alice"));
    });

    it("/skills lists the catalog (host env may add skills)", async () => {
      const r = await gw.handleIncoming(msg("/skills"));
      if (r.startsWith("No skills yet")) {
        assert.ok(r.includes("/skills create"), r);
        return;
      }
      assert.ok(r.startsWith("Skills ("), r);
      assert.ok(r.includes("Use: /skills use <name>"));
      assert.ok(r.includes("Create: /skills create"));
    });

    it("unknown commands fall through to the agent", async () => {
      const r = await gw.handleIncoming(msg("/frobnicate"));
      assert.equal(agent.runCalls.length, 1);
      assert.equal(agent.runCalls[0]!.msg.text, "/frobnicate");
      assert.equal(r, "ok");
    });
  });

  describe("agent turns", () => {
    it("delivers the final answer on the CLI channel", async () => {
      agent.runResult = {
        text: "Hello back",
        sessionKey: "cli:local",
        toolCalls: 0,
        durationMs: 5,
      };
      const lines = await withLog(async () => {
        const r = await gw.handleIncoming(msg("hello"));
        assert.equal(r, "Hello back");
      });
      assert.deepEqual(lines, ["Hello back"]);
      assert.equal(agent.runCalls.length, 1);
    });

    it("suppresses HEARTBEAT_OK replies", async () => {
      agent.runResult = {
        text: "HEARTBEAT_OK",
        sessionKey: "cron:heartbeat",
        toolCalls: 0,
        durationMs: 1,
      };
      const lines = await withLog(async () => {
        const r = await gw.handleIncoming(msg("HEARTBEAT_OK", "cron", "cron:heartbeat"));
        assert.equal(r, "");
      });
      assert.deepEqual(lines, []);
    });

    it("streams live narration and tool names in minimal mode", async () => {
      agent.onRun = async (_m, opts) => {
        const p = progressOf(opts);
        await p({ kind: "text", text: "Checking" });
        await p({ kind: "tool_start", id: "t1", name: "bash", args: "command=ls" });
        await p({
          kind: "tool_end",
          id: "t1",
          name: "bash",
          args: "command=ls",
          ok: true,
          detail: "ok",
        });
        return {
          text: "Checking\n\nDone.",
          tailText: "Done.",
          sessionKey: "cli:local",
          toolCalls: 1,
          durationMs: 5,
          steps: ["→ bash command=ls", "✓ bash — ok"],
        };
      };
      const lines = await withLog(async () => {
        const r = await gw.handleIncoming(msg("run it"));
        assert.equal(r, "Checking\n\nDone.");
      });
      // mid-turn text + minimal tool name + final tail (no meta footer in minimal mode)
      assert.deepEqual(lines, ["Checking", "⚙ bash", "Done."]);
    });

    it("delivers thoughts when /thoughts on", async () => {
      const key = "telegram:42";
      await gw.handleIncoming(msg("/thoughts on", "telegram", "42", "chat42"));
      agent.onRun = async (_m, opts) => {
        const p = progressOf(opts);
        await p({ kind: "thought", text: "let me think" });
        return {
          text: "Answer",
          sessionKey: key,
          toolCalls: 0,
          durationMs: 5,
          thoughts: "let me think",
        };
      };
      const r = await gw.handleIncoming(msg("q", "telegram", "42", "chat42"));
      assert.equal(r, "Answer");
      // sent[0] is the /thoughts on command reply; then thought + final
      assert.equal(tg.sent.length, 3);
      assert.match(tg.sent[1]!.text, /blockquote expandable>let me think<\/blockquote>/);
      assert.equal(tg.sent[2]!.text, formatFinalHtml("Answer", { durationMs: 5, toolCalls: 0 }));
    });

    it("shows a Thinking… indicator in minimal mode and deletes it", async () => {
      agent.onRun = async (_m, opts) => {
        const p = progressOf(opts);
        await p({ kind: "thinking_start" });
        await p({ kind: "thinking_end" });
        return { text: "Answer", sessionKey: "telegram:42", toolCalls: 0, durationMs: 5 };
      };
      const r = await gw.handleIncoming(msg("q", "telegram", "42", "chat42"));
      assert.equal(r, "Answer");
      assert.equal(tg.sent[0]!.text, "<i>Thinking…</i>");
      assert.deepEqual(tg.deleted, [{ chatId: "chat42", messageId: 100 }]);
      assert.ok(tg.typingCalls.length >= 1, "typing indicator should fire");
    });

    it("edits tool messages in place when /steps on", async () => {
      await gw.handleIncoming(msg("/steps on", "telegram", "42", "chat42"));
      agent.onRun = async (_m, opts) => {
        const p = progressOf(opts);
        await p({ kind: "tool_start", id: "t1", name: "bash", args: "command=ls" });
        await p({
          kind: "tool_end",
          id: "t1",
          name: "bash",
          args: "command=ls",
          ok: true,
          detail: "ok",
        });
        return { text: "Done.", sessionKey: "telegram:42", toolCalls: 1, durationMs: 5 };
      };
      await gw.handleIncoming(msg("run it", "telegram", "42", "chat42"));
      // sent[0] is the /steps on command reply; then running bubble (id 101), edit, final
      assert.equal(tg.sent.length, 4);
      assert.equal(tg.sent[1]!.text, formatToolRunningHtml("bash", "command=ls"));
      assert.equal(tg.sent[2]!.editMessageId, 101, "result should edit the running… bubble");
      assert.equal(tg.sent[2]!.text, formatToolDoneHtml("bash", "command=ls", true, "ok"));
      assert.equal(tg.sent[3]!.text, formatFinalHtml("Done.", { durationMs: 5, toolCalls: 1 }));
    });

    it("serializes turns per peer but runs different peers concurrently", async () => {
      let concurrent = 0;
      let maxSame = 0;
      let maxCross = 0;
      agent.onRun = async () => {
        concurrent += 1;
        maxCross = Math.max(maxCross, concurrent);
        await sleep(30);
        concurrent -= 1;
        return { text: "done", sessionKey: "x", toolCalls: 0, durationMs: 1 };
      };
      await Promise.all([
        gw.handleIncoming(msg("a", "cli", "p1")),
        gw.handleIncoming(msg("b", "cli", "p1")),
        gw.handleIncoming(msg("c", "cli", "p1")),
      ]);
      maxSame = maxCross;
      maxCross = 0;
      await Promise.all([
        gw.handleIncoming(msg("d", "cli", "p2")),
        gw.handleIncoming(msg("e", "cli", "p3")),
        gw.handleIncoming(msg("f", "cli", "p4")),
      ]);
      assert.equal(maxSame, 1, "same peer must be serialized");
      assert.equal(maxCross, 3, "different peers should overlap");
    });
  });

  describe("cron delivery", () => {
    it("delivers cron results to telegram with a formatted header", async () => {
      agent.runResult = {
        text: "Here is your brief",
        sessionKey: "cron:job1",
        toolCalls: 0,
        durationMs: 1,
      };
      await gw.runCronJob(cronJob());
      assert.equal(tg.sent.length, 1);
      assert.equal(tg.sent[0]!.text, formatCronHtml("morning-brief", "Here is your brief"));
      const opts = agent.runCalls[0]!.opts as { deliverHint?: unknown; ephemeral?: boolean };
      assert.deepEqual(opts.deliverHint, {
        channel: "telegram",
        peerId: "telegram:42",
        chatId: "42",
      });
      assert.equal(opts.ephemeral, false);
    });

    it("delivers cron results to the CLI channel", async () => {
      const job = cronJob({ deliver: { channel: "cli", peerId: "local", chatId: undefined } });
      agent.runResult = {
        text: "brief here",
        sessionKey: "cron:job1",
        toolCalls: 0,
        durationMs: 1,
      };
      const lines = await withLog(async () => {
        await gw.runCronJob(job);
      });
      assert.deepEqual(lines, ["⏰ morning-brief\n\nbrief here"]);
    });

    it("suppresses heartbeat cron turns", async () => {
      const job = cronJob({
        id: "heartbeat",
        name: "heartbeat",
        prompt: "HEARTBEAT_CHECK",
        deliver: { channel: "telegram", peerId: "telegram:42", chatId: "42" },
      });
      agent.runResult = {
        text: "HEARTBEAT_OK",
        sessionKey: "cron:heartbeat",
        toolCalls: 0,
        durationMs: 1,
      };
      await gw.runCronJob(job);
      assert.equal(tg.sent.length, 0);
      const opts = agent.runCalls[0]!.opts as { ephemeral?: boolean };
      assert.equal(opts.ephemeral, true, "heartbeat runs should be ephemeral");
    });
  });

  describe("pairing", () => {
    it("approves a code and reports the paired user", async () => {
      tg.approveResult = { ok: true, userId: "99" };
      const r = await gw.pair("AB12CD34");
      assert.equal(r, "Paired user 99. They can chat with the bot now.");
    });

    it("surfaces approval errors", async () => {
      tg.approveResult = { ok: false, error: "Unknown or expired code" };
      const r = await gw.pair("AB12CD34");
      assert.equal(r, "Pairing failed: Unknown or expired code");
    });
  });

  describe("lifecycle", () => {
    it("start wires the telegram handler; stop disposes everything", async () => {
      await gw.start();
      assert.equal(tg.started, true);
      assert.equal(typeof tg.handler, "function");
      // Messages from telegram flow through the wiring
      await tg.handler!(msg("hi", "telegram", "42", "chat42"));
      assert.equal(agent.runCalls.length, 1);
      await gw.stop();
      assert.equal(tg.started, false);
      assert.equal(agent.disposed, true);
    });
  });
});
