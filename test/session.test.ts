import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry, makeSessionKey } from "../src/session/manager.js";
import type { AppConfig } from "../src/config.js";

function miniCfg(dataDir: string): AppConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
    cwd: dataDir,
    agentName: "test",
    model: { provider: "supergrok", id: "grok-4.5", thinking: "medium" },
    telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [] },
    logging: { level: "error" },
  } as AppConfig;
}

describe("SessionRegistry history + resume", () => {
  let dir: string;
  let sessions: SessionRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-agent-sess-"));
    sessions = new SessionRegistry(miniCfg(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("makeSessionKey formats channel:peer", () => {
    assert.equal(makeSessionKey("cli", "local"), "cli:local");
    assert.equal(makeSessionKey("telegram", "123"), "telegram:123");
  });

  it("archives current session on reset", () => {
    const rec = sessions.getOrCreate("cli", "local", "user");
    const peerDir = sessions.peerDir(rec.key, rec.sessionId);
    const file = join(peerDir, `test_${rec.sessionId}.jsonl`);
    writeFileSync(file, '{"type":"session"}\n', "utf8");
    sessions.setSessionFile(rec.key, file, rec.sessionId);
    sessions.touch(rec.key, 3);

    const oldId = rec.sessionId;
    const next = sessions.reset(rec.key);
    assert.ok(next);
    assert.notEqual(next!.sessionId, oldId);
    assert.equal(next!.messageCount, 0);
    assert.equal(next!.sessionFile, undefined);

    const hist = sessions.listHistory(rec.key);
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.sessionId, oldId);
    assert.equal(hist[0]!.messageCount, 3);
    assert.equal(hist[0]!.sessionFile, file);
    assert.equal(hist[0]!.active, false);
  });

  it("does not archive empty sessions on reset", () => {
    const rec = sessions.getOrCreate("cli", "empty");
    sessions.reset(rec.key);
    assert.equal(sessions.listHistory(rec.key).length, 0);
  });

  it("resumes an archived session by id prefix", () => {
    const rec = sessions.getOrCreate("cli", "local");
    const peerDir = sessions.peerDir(rec.key, rec.sessionId);
    const file = join(peerDir, `t_${rec.sessionId}.jsonl`);
    writeFileSync(file, "x\n", "utf8");
    sessions.setSessionFile(rec.key, file, rec.sessionId);
    sessions.touch(rec.key, 2);
    const oldId = rec.sessionId;

    sessions.reset(rec.key);
    assert.equal(sessions.listHistory(rec.key).length, 1);

    const prefix = oldId.slice(0, 8);
    const result = sessions.resume(rec.key, prefix);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rec.sessionId, oldId);
    assert.equal(result.rec.sessionFile, file);
    assert.equal(result.rec.messageCount, 2);
    // resumed session is no longer in history
    assert.equal(sessions.listHistory(rec.key).length, 0);
  });

  it("archives current when resuming another", () => {
    const rec = sessions.getOrCreate("telegram", "99", "alice");
    const d1 = sessions.peerDir(rec.key, rec.sessionId);
    const f1 = join(d1, `a_${rec.sessionId}.jsonl`);
    writeFileSync(f1, "a\n", "utf8");
    sessions.setSessionFile(rec.key, f1, rec.sessionId);
    sessions.touch(rec.key, 1);
    const id1 = sessions.get(rec.key)!.sessionId;

    sessions.reset(rec.key);
    const rec2 = sessions.get(rec.key)!;
    const d2 = sessions.peerDir(rec.key, rec2.sessionId);
    const f2 = join(d2, `b_${rec2.sessionId}.jsonl`);
    writeFileSync(f2, "b\n", "utf8");
    sessions.setSessionFile(rec.key, f2, rec2.sessionId);
    sessions.touch(rec.key, 5);
    const id2 = sessions.get(rec.key)!.sessionId;

    const r = sessions.resume(rec.key, id1);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.rec.sessionId, id1);

    const hist = sessions.listHistory(rec.key);
    assert.ok(hist.some((h) => h.sessionId === id2));
    assert.ok(!hist.some((h) => h.sessionId === id1));
  });

  it("resumeById finds across peers", () => {
    const a = sessions.getOrCreate("cli", "a");
    const d = sessions.peerDir(a.key, a.sessionId);
    const f = join(d, `x_${a.sessionId}.jsonl`);
    writeFileSync(f, "x\n", "utf8");
    sessions.setSessionFile(a.key, f, a.sessionId);
    sessions.touch(a.key, 1);
    const id = a.sessionId;
    sessions.reset(a.key);

    const r = sessions.resumeById(id);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.rec.key, "cli:a");
    assert.equal(r.rec.sessionId, id);
  });

  it("listTranscriptFiles discovers jsonl under pi-sessions", () => {
    const rec = sessions.getOrCreate("cli", "local");
    const peerDir = sessions.peerDir(rec.key, rec.sessionId);
    mkdirSync(peerDir, { recursive: true });
    const sid = "019f841c-155c-77b5-93ab-0e7fdbc0f439";
    const file = join(peerDir, `2026-07-21T09-57-40-828Z_${sid}.jsonl`);
    writeFileSync(file, "z\n", "utf8");

    const files = sessions.listTranscriptFiles();
    assert.ok(files.some((f) => f.sessionId === sid && f.path === file));
  });

  it("find matches short prefix", () => {
    const rec = sessions.getOrCreate("cli", "local");
    const hits = sessions.find(rec.sessionId.slice(0, 8));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.active, true);
  });
});
