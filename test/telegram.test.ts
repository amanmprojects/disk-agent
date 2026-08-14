import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TelegramChannel } from "../src/channels/telegram.js";
import type { AppConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import type { PairingRequest } from "../src/types.js";
import { makeTestCfg } from "./helpers.js";

const NOW = "2025-01-01T00:00:00.000Z";

function pairingReq(overrides: Partial<PairingRequest> = {}): PairingRequest {
  return {
    code: "AB12CD34",
    userId: "99",
    username: "alice",
    createdAt: NOW,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TelegramChannel auth & pairing (no bot)", () => {
  let dir: string;
  let cfg: AppConfig;
  let ch: TelegramChannel;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-agent-tg-"));
    cfg = makeTestCfg(dir, {
      telegram: {
        enabled: false,
        botToken: undefined,
        dmPolicy: "allowlist",
        allowFrom: ["111"],
        ownerId: undefined,
        groupsRequireMention: true,
        streamEdits: true,
        maxMessageChars: 3900,
      },
    });
    ch = new TelegramChannel(cfg, new Logger({ level: "error" }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("isEnabled", () => {
    it("requires both enabled and a token", () => {
      assert.equal(ch.isEnabled(), false);
      cfg.telegram.enabled = true;
      assert.equal(ch.isEnabled(), false);
      cfg.telegram.botToken = "123:abc";
      assert.equal(ch.isEnabled(), true);
    });
  });

  describe("isAuthorized", () => {
    it("open policy allows everyone", () => {
      cfg.telegram.dmPolicy = "open";
      assert.equal(ch.isAuthorized("anyone"), true);
    });

    it("owner_only allows only the owner", () => {
      cfg.telegram.dmPolicy = "owner_only";
      cfg.telegram.ownerId = "42";
      assert.equal(ch.isAuthorized("42"), true);
      assert.equal(ch.isAuthorized("43"), false);
    });

    it("allowlist accepts config, file, and owner entries", () => {
      writeFileSync(join(dir, "pairings", "allowlist.json"), JSON.stringify(["222"]), "utf8");
      cfg.telegram.ownerId = "333";
      assert.equal(ch.isAuthorized("111"), true, "config allowFrom");
      assert.equal(ch.isAuthorized("222"), true, "allowlist.json");
      assert.equal(ch.isAuthorized("333"), true, "owner");
      assert.equal(ch.isAuthorized("999"), false);
    });

    it("pairing policy falls back to the allowlist", () => {
      cfg.telegram.dmPolicy = "pairing";
      assert.equal(ch.isAuthorized("111"), true);
      assert.equal(ch.isAuthorized("999"), false);
    });

    it("getAllowlist dedupes and stringifies", () => {
      writeFileSync(join(dir, "pairings", "allowlist.json"), JSON.stringify(["222", 111]), "utf8");
      cfg.telegram.ownerId = "42";
      const out = ch.getAllowlist();
      assert.deepEqual(out, ["42", "111", "222"]);
    });
  });

  describe("approvePairing", () => {
    it("approves a valid code, persists the user, and promotes the first to owner", async () => {
      writeFileSync(
        join(dir, "pairings", "pending.json"),
        JSON.stringify({ 99: pairingReq() }),
        "utf8",
      );
      const r = await ch.approvePairing("AB12CD34");
      assert.deepEqual(r, { ok: true, userId: "99" });
      assert.equal(cfg.telegram.ownerId, "99", "first paired user becomes owner");
      assert.ok(ch.getAllowlist().includes("99"), "paired user joins the allowlist");
      const pending = ch.listPendingPairings();
      assert.equal(pending.length, 0, "used code is removed");
    });

    it("rejects unknown codes", async () => {
      const r = await ch.approvePairing("NOPE1234");
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /Unknown or expired/);
    });

    it("rejects and cleans up expired codes", async () => {
      writeFileSync(
        join(dir, "pairings", "pending.json"),
        JSON.stringify({ 99: pairingReq({ expiresAt: "2000-01-01T00:00:00.000Z" }) }),
        "utf8",
      );
      const r = await ch.approvePairing("AB12CD34");
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /expired/i);
      assert.equal(ch.listPendingPairings().length, 0);
      assert.ok(!ch.getAllowlist().includes("99"), "expired pairing never joins the allowlist");
    });

    it("does not overwrite an existing owner", async () => {
      cfg.telegram.ownerId = "1";
      writeFileSync(
        join(dir, "pairings", "pending.json"),
        JSON.stringify({ 99: pairingReq() }),
        "utf8",
      );
      await ch.approvePairing("AB12CD34");
      assert.equal(cfg.telegram.ownerId, "1");
      assert.ok(ch.getAllowlist().includes("99"));
    });
  });

  describe("listPendingPairings", () => {
    it("filters out expired codes", () => {
      writeFileSync(
        join(dir, "pairings", "pending.json"),
        JSON.stringify({
          1: pairingReq({ userId: "1", code: "AAA11111" }),
          2: pairingReq({ userId: "2", code: "BBB22222", expiresAt: "2000-01-01T00:00:00.000Z" }),
        }),
        "utf8",
      );
      const pending = ch.listPendingPairings();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.code, "AAA11111");
    });
  });

  describe("send without a bot", () => {
    it("returns undefined and does not throw", async () => {
      const out = await ch.send({
        channel: "telegram",
        peerId: "telegram:42",
        chatId: "42",
        text: "hello",
      });
      assert.equal(out, undefined);
    });
  });
});
