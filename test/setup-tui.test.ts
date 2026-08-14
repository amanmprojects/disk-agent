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
        anthropic: { type: "oauth", token: "…" },
      }),
    );
    const got = readPiAuthProviders(join(dir, "auth.json"));
    assert.deepEqual([...got].sort(), ["anthropic", "opencode-go"]);
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

test("collectPiModels: SDK timeout falls back to raw models-store", async () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      "models-store.json",
      JSON.stringify({
        "opencode-go": { models: [{ id: "grok-4.5", name: "Grok 4.5" }] },
      }),
    );
    const start = Date.now();
    const info = await collectPiModels(dir, {
      timeoutMs: 40,
      // Simulate an unresponsive ModelRuntime.create (offline-but-unguarded).
      createRuntime: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - start < 2_000, "must not wait for the hung runtime");
    assert.ok(info.candidates.some((c) => c.label === "opencode-go/grok-4.5"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPiModels: injected runtime factory is used", async () => {
  const dir = tmpDir();
  try {
    const info = await collectPiModels(dir, {
      // A minimal stand-in for ModelRuntime.create.
      createRuntime: async () =>
        ({
          getRegisteredProviderIds: () => ["opencode-go"],
          getModels: () => [{ id: "from-factory", name: "From Factory" }],
        }) as never,
    });
    assert.ok(info.candidates.some((c) => c.label === "opencode-go/from-factory"));
    assert.ok(info.candidates.some((c) => c.source === "pi-catalog"));
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
        model: "opencode-go/grok-4.5",
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
            provider: "anthropic",
            id: "claude-sonnet-4-20250514",
            label: "anthropic/claude-sonnet-4-20250514",
            source: "preset" as const,
            authed: false,
          },
        ],
        defaultProvider: "opencode-go",
        defaultModel: "deepseek-v4-flash",
      },
      auth: { providers: ["opencode-go"], envKeys: ["OPENCODE_API_KEY"] },
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

    // Pi components: yes (default) → Enter
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    // Browser: yes (default) → Enter (lands on the auth screen)
    setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    // Auth status line rendered from ctx.auth.
    assert.match(setup.captureCharFrame(), /Already authenticated/);
    assert.match(setup.captureCharFrame(), /opencode-go/);
    assert.match(setup.captureCharFrame(), /OPENCODE_API_KEY/);
    // Auth: opencode-go (default) → Enter
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
    assert.equal(values.loginProvider, "opencode-go");
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
      existing: { agentName: "Disk", model: "opencode-go/grok-4.5", cwd: "/tmp" },
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

// ── Wizard install phase (Bun only) ───────────────────────────────────────

/** Drive the wizard to the summary screen and press Enter to start installs. */
async function driveToSummary(
  setup: Awaited<ReturnType<typeof import("@opentui/core/testing")["createTestRenderer"]>>,
  opts?: { skipBrowser?: boolean },
): Promise<void> {
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // welcome
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // agent name
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // agent cwd → model
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // model (pi default)
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // telegram token (blank)
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // telegram owner (blank) → pi
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // pi components (yes)
  await setup.renderOnce();
  if (opts?.skipBrowser) {
    setup.mockInput.pressKey("ARROW_DOWN"); // browser: no
    await setup.renderOnce();
  }
  setup.mockInput.pressKey("RETURN"); // browser (yes or no) → auth
  await setup.renderOnce();
  setup.mockInput.pressKey("RETURN"); // auth (opencode-go) → summary
  await setup.renderOnce();
}

function testCtx(): Parameters<typeof import("../src/setup/tui.js")["Wizard"]>[1] {
  return {
    version: "9.9.9-test",
    existing: { agentName: "Disk", model: "opencode-go/grok-4.5", cwd: "/home/test" },
    piInfo: {
      candidates: [
        {
          provider: "opencode-go",
          id: "deepseek-v4-flash",
          label: "opencode-go/deepseek-v4-flash",
          source: "pi-default" as const,
          authed: true,
        },
      ],
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
    },
    auth: { providers: ["opencode-go"], envKeys: ["OPENCODE_API_KEY"] },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("wizard: install phase shows live status and completes", { skip: !IS_BUN }, async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { Wizard } = await import("../src/setup/tui.js");

  const setup = await createTestRenderer({ width: 90, height: 30 });
  try {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const calls: string[] = [];
    const steps = [
      {
        id: "pi",
        title: "Install Pi CLI",
        build: () => async () => {
          calls.push("pi");
          await firstGate;
          return { ok: true, detail: "pi ok" };
        },
      },
      {
        id: "browser",
        title: "Install agent-browser",
        skipWhen: (v: { skipBrowser: boolean }) => v.skipBrowser,
        build: () => async () => {
          calls.push("browser");
          return { ok: true, detail: "browser ok" };
        },
      },
    ];

    const wizard = new Wizard(setup.renderer, testCtx(), { steps });
    const finished = new Promise<{
      values: unknown;
      install: unknown;
    }>((resolve) => {
      wizard.onFinish = (values, install) => resolve({ values, install });
    });
    const stalled = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("wizard stalled before finishing")), 8000),
    );

    wizard.start();
    await driveToSummary(setup, { skipBrowser: true });
    assert.match(setup.captureCharFrame(), /Installs run inside the wizard/);

    setup.mockInput.pressKey("RETURN"); // Review & run → install phase
    await flush();
    await setup.renderOnce();

    // pi running (gated), browser skipped
    assert.match(setup.captureCharFrame(), /▶/);
    assert.match(setup.captureCharFrame(), /Install Pi CLI/);
    assert.match(setup.captureCharFrame(), /–/);

    releaseFirst();
    await flush();
    await setup.renderOnce();

    assert.match(setup.captureCharFrame(), /Setup complete/);
    assert.deepEqual(calls, ["pi"]); // skipped step never ran

    setup.mockInput.pressKey("RETURN"); // done screen → finish
    const out = (await Promise.race([finished, stalled])) as {
      values: { agentName: string };
      install: { aborted: boolean; results: Array<{ id: string; result: { detail: string } }> };
    };
    assert.equal(out.values.agentName, "Disk");
    assert.equal(out.install.aborted, false);
    assert.equal(out.install.results.length, 1);
    assert.equal(out.install.results[0]?.id, "pi");
    assert.equal(out.install.results[0]?.result.detail, "pi ok");
  } finally {
    setup.renderer.destroy();
  }
});

test("wizard: failed step shows stderr tail + exit code; Retry succeeds", {
  skip: !IS_BUN,
}, async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { Wizard } = await import("../src/setup/tui.js");

  const setup = await createTestRenderer({ width: 90, height: 30 });
  try {
    const steps = [
      {
        id: "pi",
        title: "Install Pi CLI",
        build: () => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) {
              return {
                ok: false,
                detail: "npm install failed",
                exitCode: 1,
                stderrTail: "ERR! boom",
              };
            }
            return { ok: true, detail: "pi ok" };
          };
        },
      },
    ];
    const wizard = new Wizard(setup.renderer, testCtx(), { steps });
    const finished = new Promise<{ install: unknown }>((resolve) => {
      wizard.onFinish = (_values, install) => resolve({ install });
    });
    const stalled = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("wizard stalled before finishing")), 8000),
    );

    wizard.start();
    await driveToSummary(setup);
    setup.mockInput.pressKey("RETURN"); // → install phase
    await flush();
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    assert.match(frame, /✗/);
    assert.match(frame, /exit code: 1/);
    assert.match(frame, /ERR! boom/);
    assert.match(frame, /Retry/);

    // RETURN on the focused Retry/Abort select → retry (gotcha #12 regression)
    setup.mockInput.pressKey("RETURN");
    await flush();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Setup complete/);

    setup.mockInput.pressKey("RETURN"); // finish
    const out = (await Promise.race([finished, stalled])) as {
      install: { aborted: boolean; results: Array<{ result: { detail: string } }> };
    };
    assert.equal(out.install.aborted, false);
    assert.equal(out.install.results[0]?.result.detail, "pi ok");
  } finally {
    setup.renderer.destroy();
  }
});

test("wizard: Abort on failure ends install phase", { skip: !IS_BUN }, async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { Wizard } = await import("../src/setup/tui.js");

  const setup = await createTestRenderer({ width: 90, height: 30 });
  try {
    const calls: string[] = [];
    const steps = [
      {
        id: "pi",
        title: "Install Pi CLI",
        build: () => async () => {
          calls.push("pi");
          return { ok: false, detail: "boom", exitCode: 7, stderrTail: "fatal" };
        },
      },
      {
        id: "auth",
        title: "Authenticate",
        build: () => async () => {
          calls.push("auth");
          return { ok: true, detail: "auth ok" };
        },
      },
    ];
    const wizard = new Wizard(setup.renderer, testCtx(), { steps });
    const finished = new Promise<{ install: unknown }>((resolve) => {
      wizard.onFinish = (_values, install) => resolve({ install });
    });
    const stalled = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("wizard stalled before finishing")), 8000),
    );

    wizard.start();
    await driveToSummary(setup);
    setup.mockInput.pressKey("RETURN"); // → install phase
    await flush();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /exit code: 7/);

    setup.mockInput.pressKey("ESCAPE"); // abort on failure panel
    await new Promise((r) => setTimeout(r, 80)); // ESC is an incomplete sequence
    await flush();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Setup aborted/);

    setup.mockInput.pressKey("RETURN"); // finish
    const out = (await Promise.race([finished, stalled])) as { install: { aborted: boolean } };
    assert.equal(out.install.aborted, true);
    assert.deepEqual(calls, ["pi"]); // later step never ran
  } finally {
    setup.renderer.destroy();
  }
});
