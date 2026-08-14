/**
 * Tests for the OpenTUI setup wizard + Pi model/provider import.
 *
 * The pi-import parsing tests are pure and run under any Node.
 * The wizard flow tests drive the real renderer via createTestRenderer,
 * which needs the native FFI library — they only run under Bun
 * (`bun test` or `bunx tsx --test`). Under plain Node they skip.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectPiModels,
  readPiAuthProviders,
  readPiDefault,
  readPiModelsStore,
} from "../src/setup/pi-import.js";

const IS_BUN = typeof process.versions.bun === "string";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "disk-agent-setup-"));
}

function write(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

test("readPiAuthProviders: provider keys from auth.json", () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      "auth.json",
      JSON.stringify({
        "opencode-go": { type: "api_key", key: "oc_secret" },
        supergrok: { type: "oauth", token: "…" },
      }),
    );
    const got = readPiAuthProviders(join(dir, "auth.json"));
    assert.deepEqual([...got].sort(), ["opencode-go", "supergrok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiAuthProviders: missing/malformed file → empty", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readPiAuthProviders(join(dir, "nope.json")), []);
    write(dir, "bad.json", "not json{");
    assert.deepEqual(readPiAuthProviders(join(dir, "bad.json")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiModelsStore: per-provider model lists", () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      "models-store.json",
      JSON.stringify({
        "opencode-go": {
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
            { id: "grok-4.5", name: "Grok 4.5" },
          ],
        },
        anthropic: { models: [{ id: "claude-sonnet-4-20250514" }] },
        broken: "not-an-entry",
      }),
    );
    const store = readPiModelsStore(join(dir, "models-store.json"));
    assert.deepEqual([...store.keys()].sort(), ["anthropic", "opencode-go"]);
    assert.deepEqual(
      store.get("opencode-go")?.map((m) => m.id),
      ["deepseek-v4-flash", "grok-4.5"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiDefault: settings.json default provider/model", () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      "settings.json",
      JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "kimi-k2.6" }),
    );
    assert.deepEqual(readPiDefault(join(dir, "settings.json")), {
      provider: "opencode-go",
      model: "kimi-k2.6",
    });
    assert.deepEqual(readPiDefault(join(dir, "missing.json")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPiModels: pi default first, authed providers tagged", async () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      "auth.json",
      JSON.stringify({ "opencode-go": { type: "api_key", key: "oc_secret" } }),
    );
    write(
      dir,
      "models-store.json",
      JSON.stringify({
        "opencode-go": { models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] },
        anthropic: { models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet" }] },
      }),
    );
    write(
      dir,
      "settings.json",
      JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "deepseek-v4-flash" }),
    );

    const info = await collectPiModels(dir);
    assert.equal(info.defaultProvider, "opencode-go");
    assert.equal(info.defaultModel, "deepseek-v4-flash");
    assert.ok(info.candidates.length >= 2);

    const first = info.candidates[0];
    assert.equal(first?.label, "opencode-go/deepseek-v4-flash");
    assert.equal(first?.source, "pi-default");
    assert.equal(first?.authed, true);

    const anthropic = info.candidates.find((c) => c.provider === "anthropic");
    assert.equal(anthropic?.source, "pi-catalog");
    assert.equal(anthropic?.authed, false);

    // No duplicate labels.
    const labels = info.candidates.map((c) => c.label);
    assert.equal(new Set(labels).size, labels.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPiModels: empty pi dir → preset safety net", async () => {
  const dir = tmpDir();
  try {
    const info = await collectPiModels(dir);
    assert.ok(info.candidates.length > 0);
    assert.ok(info.candidates.every((c) => c.source === "preset"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wizard flow (Bun only — needs the native test renderer) ──────────────

test("wizard: full walkthrough collects values", { skip: !IS_BUN }, async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { Wizard } = await import("../src/setup/tui.js");

  const setup = await createTestRenderer({ width: 90, height: 30 });
  try {
    const ctx = {
      version: "9.9.9-test",
      existing: {
        agentName: "Disk",
        model: "supergrok/grok-4.5",
        cwd: "/home/test",
      },
      piInfo: {
        candidates: [
          {
            provider: "opencode-go",
            id: "deepseek-v4-flash",
            label: "opencode-go/deepseek-v4-flash",
            source: "pi-default" as const,
            authed: true,
          },
          {
            provider: "supergrok",
            id: "grok-4.5",
            label: "supergrok/grok-4.5",
            source: "preset" as const,
            authed: false,
          },
        ],
        defaultProvider: "opencode-go",
        defaultModel: "deepseek-v4-flash",
      },
      auth: { providers: ["opencode-go"], envKeys: ["XAI_API_KEY"] },
    };

    const wizard = new Wizard(setup.renderer, ctx);
    const finished = new Promise<Parameters<NonNullable<typeof wizard.onFinish>>[0]>((resolve) => {
      wizard.onFinish = resolve;
    });
    const stalled = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("wizard stalled before finishing")), 8000),
    );

    wizard.start();
    await setup.renderOnce();

    // Welcome → Enter
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Agent basics: clear prefilled name, type new one, Enter (→ cwd), Enter (→ next)
    setup.mockInput.pressKeys(["BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE"]);
    setup.mockInput.typeText("Herbie");
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Model: default selection is pi default → Enter
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Telegram: Enter (skip token) → Enter (skip owner)
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Tavily: Enter (skip)
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Pi components: yes (default) → Enter
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Browser: yes (default) → Enter (lands on the auth screen)
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    // Auth status line rendered from ctx.auth.
    assert.match(setup.captureCharFrame(), /Already authenticated/);
    assert.match(setup.captureCharFrame(), /opencode-go/);
    assert.match(setup.captureCharFrame(), /XAI_API_KEY/);
    // Auth: supergrok (default) → Enter
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Summary: Enter to run
    setup.mockInput.pressKey("RETURN");

    const values = await Promise.race([finished, stalled]);
    assert.equal(values.cancelled, undefined);
    assert.equal(values.agentName, "Herbie");
    assert.equal(values.model, "opencode-go/deepseek-v4-flash");
    assert.equal(values.cwd, "/home/test");
    assert.equal(values.skipPi, false);
    assert.equal(values.skipBrowser, false);
    assert.equal(values.skipLogin, false);
    assert.equal(values.loginProvider, "supergrok");
    assert.equal(values.telegramToken, undefined);
  } finally {
    setup.renderer.destroy();
  }
});

test("wizard: Esc on welcome cancels", { skip: !IS_BUN }, async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { Wizard } = await import("../src/setup/tui.js");

  const setup = await createTestRenderer({ width: 90, height: 30 });
  try {
    const wizard = new Wizard(setup.renderer, {
      version: "9.9.9-test",
      existing: { agentName: "Disk", model: "supergrok/grok-4.5", cwd: "/tmp" },
      piInfo: { candidates: [], defaultProvider: undefined, defaultModel: undefined },
    });
    let cancelled = false;
    wizard.onCancel = () => {
      cancelled = true;
    };
    wizard.start();
    await setup.renderOnce();
    setup.mockInput.pressKey("ESCAPE");
    // ESC alone is an incomplete escape sequence — give the parser time.
    await new Promise((r) => setTimeout(r, 80));
    await setup.renderOnce();
    assert.equal(cancelled, true);
  } finally {
    setup.renderer.destroy();
  }
});
