/**
 * OpenTUI-based interactive setup wizard.
 *
 * Runs when the runtime can create the native OpenTUI renderer (Bun, or
 * Node >= 26.4 with --experimental-ffi). `runSetup` falls back to the
 * classic readline prompts otherwise (see setup.ts).
 *
 * Uses the raw `@opentui/core` constructs API (Box/Text/Input/Select) —
 * deliberately not the React bindings: no extra React tree, no JSX
 * transform, and a linear wizard is a perfect fit for constructs.
 */

import type { SelectOption } from "@opentui/core";
import {
  Box,
  type CliRenderer,
  createCliRenderer,
  Input,
  InputRenderableEvents,
  Select,
  SelectRenderableEvents,
  Text,
  type VChild,
} from "@opentui/core";
import {
  createInstallRun,
  type InstallRunController,
  type StepResult,
  stderrTail,
} from "./install-steps.js";
import { collectPiModels, type PiModelCandidate, type PiModelInfo } from "./pi-import.js";

/** Values the wizard collected. Merged into SetupOptions by runSetup. */
export interface TuiValues {
  agentName: string;
  /** provider/id, e.g. "opencode-go/deepseek-v4-flash". */
  model?: string;
  cwd?: string;
  telegramToken?: string;
  ownerId?: string;
  skipPi: boolean;
  skipBrowser: boolean;
  skipLogin: boolean;
  loginProvider?: "opencode-go";
}

export interface TuiOutcome {
  cancelled: boolean;
  /** createCliRenderer failed (no native FFI) — caller should fall back. */
  rendererFailed?: boolean;
  values?: TuiValues;
  /** Present when the wizard ran the install phase after "Review & run". */
  install?: { aborted: boolean; results: Array<{ id: string; result: StepResult }> };
}

export interface TuiExistingValues {
  agentName: string;
  model: string;
  cwd: string;
  telegramToken?: string;
  ownerId?: string;
}

/** Install step for the in-wizard install phase (built by setup.ts). */
export interface InstallPhaseStep {
  id: string;
  title: string;
  /** Suspend the renderer (leave the alternate screen) while this step runs. */
  suspendForRun?: boolean;
  /** Skip decision from the wizard's final collected values. */
  skipWhen?: (values: TuiValues) => boolean;
  run: () => Promise<StepResult>;
}

export interface WizardOptions {
  steps?: InstallPhaseStep[];
}

/** What credentials already exist (shown on the auth screen). */
export interface TuiAuthInfo {
  /** Providers with credentials in ~/.pi/agent/auth.json. */
  providers: string[];
  /** Relevant env keys that are set (OPENCODE_API_KEY, ANTHROPIC_API_KEY, …). */
  envKeys: string[];
}

export interface TuiContext {
  version: string;
  existing: TuiExistingValues;
  piInfo: PiModelInfo;
  /** Credentials that already exist — shown on the auth screen. */
  auth?: TuiAuthInfo;
}

const SCREEN_ID = "wizard-screen";
const WIDTH = 64;

type ScreenBuilder = () => VChild;

/** Colors — readable on dark terminals. */
const C = {
  title: "#00D7FF",
  label: "#9A9A9A",
  accent: "#FFD700",
  ok: "#5FD75F",
  dim: "#6C6C6C",
  inputBg: "#1E1E1E",
  inputFocusBg: "#2E3A4A",
};

/** True when the current runtime can create the native OpenTUI renderer. */
export function canUseOpentui(): boolean {
  if (typeof process.versions.bun === "string") return true;
  const [major, minor] = process.versions.node.split(".").map((n) => Number(n) || 0);
  if (major < 26 || (major === 26 && minor < 4)) return false;
  // Node >= 26.4 ships experimental FFI, but it must be enabled.
  return (
    process.execArgv.includes("--experimental-ffi") ||
    Boolean(process.env.NODE_OPTIONS?.includes("--experimental-ffi"))
  );
}

/**
 * Run the interactive wizard. Resolves with collected values, or
 * { cancelled: true } when the user quits (Esc / Ctrl+C).
 */
export async function runTuiSetup(ctx: TuiContext, opts: WizardOptions = {}): Promise<TuiOutcome> {
  const settled = { current: false };
  let resolveOutcome: (outcome: TuiOutcome) => void = () => {};
  const outcome = new Promise<TuiOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      // Ctrl+C / signals destroy the renderer — surface as cancel.
      onDestroy: () => {
        if (!settled.current) {
          settled.current = true;
          resolveOutcome({ cancelled: true });
        }
      },
    });
  } catch {
    settled.current = true;
    return { cancelled: true, rendererFailed: true };
  }

  const finish = (result: TuiOutcome): void => {
    if (settled.current) return;
    settled.current = true;
    try {
      renderer.destroy();
    } catch {
      /* already destroyed */
    }
    resolveOutcome(result);
  };

  const wizard = new Wizard(renderer, ctx, opts);
  wizard.onFinish = (values: TuiValues, install?: TuiOutcome["install"]) =>
    finish({ cancelled: false, values, install });
  wizard.onCancel = () => finish({ cancelled: true });
  wizard.start();

  return outcome;
}

interface WizardState {
  agentName: string;
  cwd: string;
  model?: string;
  manualModel: boolean;
  telegramToken?: string;
  ownerId?: string;
  skipPi: boolean;
  skipBrowser: boolean;
  skipLogin: boolean;
  loginProvider?: "opencode-go";
}

/** Builds the fixed "existing value" context for prefill + hints. */
function stateFrom(ctx: TuiContext): WizardState {
  return {
    agentName: ctx.existing.agentName,
    cwd: ctx.existing.cwd,
    model: ctx.existing.model,
    manualModel: false,
    telegramToken: ctx.existing.telegramToken,
    ownerId: ctx.existing.ownerId,
    skipPi: false,
    skipBrowser: false,
    skipLogin: false,
    loginProvider: "opencode-go",
  };
}

/**
 * The wizard state machine. Exported for tests (drive with a test renderer);
 * `runTuiSetup` wires it to a real CliRenderer.
 */
export class Wizard {
  onFinish: (values: TuiValues, install?: TuiOutcome["install"]) => void = () => {};
  onCancel: () => void = () => {};

  private readonly renderer: CliRenderer;
  private readonly ctx: TuiContext;
  private readonly state: WizardState;
  private builders: ScreenBuilder[] = [];
  private step = 0;
  /** In-wizard install steps (empty = no install phase; summary Enter finishes). */
  private readonly phaseSteps: InstallPhaseStep[];
  /** collect = value screens; install = running steps; done = final summary. */
  private phase: "collect" | "install" | "done" = "collect";
  /** Set when the renderer is destroyed (Ctrl+C / signals) — stops the install pump. */
  private destroyed = false;
  private installRun: InstallRunController | null = null;
  private frameTick = 0;
  private frameCallback: ((deltaTime: number) => Promise<void>) | null = null;
  private failureDecision: { resolve: (decision: "retry" | "abort") => void } | null = null;
  /** Input ids for Tab navigation on the current screen. */
  private tabTargets: string[] = [];
  private tabIndex = 0;
  /** First focusable (input or select) of the current screen. */
  private focusRootId: string | undefined;

  constructor(renderer: CliRenderer, ctx: TuiContext, opts: WizardOptions = {}) {
    this.renderer = renderer;
    this.ctx = ctx;
    this.state = stateFrom(ctx);
    this.phaseSteps = opts.steps ?? [];
    // Ctrl+C / signal destroy: stop the install pump so no further steps run
    // and any pending failure decision resolves as abort (no orphaned installs).
    this.renderer.on?.("destroy", this.handleDestroy);
  }

  private readonly handleDestroy = (): void => {
    this.destroyed = true;
    this.clearSpinner();
    this.resolveFailure("abort");
  };

  start(): void {
    this.builders = this.screens();
    this.renderer.keyInput.on("keypress", (key) => {
      if (key.name === "escape") {
        if (this.phase === "collect") {
          if (this.step === 0) this.onCancel();
          else this.back();
        } else if (this.phase === "install") {
          const failedId = this.installRun?.failedStepId;
          if (failedId && this.installRun?.canAbort(failedId)) this.resolveFailure("abort");
        }
        return;
      }
      if (key.name === "tab" && this.tabTargets.length) {
        key.preventDefault();
        this.tabIndex = (this.tabIndex + 1) % this.tabTargets.length;
        this.focusTab();
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        if (this.phase === "collect") {
          if (this.step === 0) {
            key.preventDefault();
            this.next();
          } else if (this.step === this.builders.length - 1) {
            key.preventDefault();
            if (this.phaseSteps.length) void this.startInstall();
            else this.finish();
          }
        } else if (this.phase === "done") {
          key.preventDefault();
          this.finish();
        }
        // install phase: the Retry/Abort select handles Enter itself
      }
    });
    this.show();
  }

  private focusTab(): void {
    const id = this.tabTargets[this.tabIndex];
    this.focusId(id);
  }

  /** getRenderable(id) only matches direct children — walk the tree. */
  private findById(id: string): import("@opentui/core").Renderable | undefined {
    const stack = [...this.renderer.root.getChildren()];
    while (stack.length) {
      const el = stack.pop();
      if (!el) continue;
      if (el.id === id) return el;
      const kids = (el as { getChildren?: () => unknown[] }).getChildren?.() ?? [];
      stack.push(...(kids as import("@opentui/core").Renderable[]));
    }
    return undefined;
  }

  private focusId(id: string | undefined): void {
    if (!id) return;
    const el = this.findById(id);
    if (el && typeof (el as { focus?: () => void }).focus === "function") {
      (el as { focus: () => void }).focus();
    }
  }

  private screens(): ScreenBuilder[] {
    return [
      () => this.welcome(),
      () => this.agentScreen(),
      () => this.modelScreen(),
      () => this.telegramScreen(),
      () =>
        this.componentScreen(
          "pi",
          "Install Pi CLI + extensions",
          ["pi-web-search (provider-native web search), pi-agent-browser-native"],
          () => this.state.skipPi,
        ),
      () =>
        this.componentScreen(
          "browser",
          "Install agent-browser + Chrome",
          [
            "Full browser automation for the agent (browser_* tools)",
            "Docs: https://agent-browser.dev/",
          ],
          () => this.state.skipBrowser,
        ),
      () => this.authScreen(),
      () => this.summary(),
    ];
  }

  private show(): void {
    const old = this.findById(SCREEN_ID);
    if (old) this.renderer.root.remove(old);
    this.tabTargets = [];
    this.tabIndex = 0;
    this.focusRootId = undefined;
    const vnode =
      this.phase === "collect"
        ? this.builders[this.step]()
        : this.phase === "install"
          ? this.installScreen()
          : this.doneScreen();
    this.renderer.root.add(vnode);
    // Focus the first focusable (input or select) — leaving the previous
    // screen's focused renderable in place would keep feeding it keys.
    this.focusId(this.focusRootId ?? this.tabTargets[0]);
  }

  next(): void {
    if (this.step < this.builders.length - 1) {
      this.step += 1;
      this.show();
    }
  }

  back(): void {
    if (this.step > 0) {
      this.step -= 1;
      this.show();
    }
  }

  private collectValues(): TuiValues {
    const s = this.state;
    return {
      agentName: s.agentName.trim() || "Disk",
      model: s.model?.trim() || undefined,
      cwd: s.cwd.trim() || undefined,
      telegramToken: s.telegramToken?.trim() || undefined,
      ownerId: s.ownerId?.trim() || undefined,
      skipPi: s.skipPi,
      skipBrowser: s.skipBrowser,
      skipLogin: s.skipLogin,
      loginProvider: s.loginProvider,
    };
  }

  private finish(): void {
    const install = this.installRun
      ? {
          aborted: this.installRun.aborted,
          results: this.installRun.steps
            .filter((s) => s.result)
            .map((s) => ({ id: s.id, result: s.result as StepResult })),
        }
      : undefined;
    this.onFinish(this.collectValues(), install);
  }

  // ── Install phase ───────────────────────────────────────────────────

  private async startInstall(): Promise<void> {
    this.phase = "install";
    const values = this.collectValues();
    const run = createInstallRun(this.phaseSteps);
    this.installRun = run;
    for (const s of this.phaseSteps) {
      if (s.skipWhen?.(values)) run.skip(s.id);
    }
    this.show();
    await this.pumpInstall();
  }

  private async pumpInstall(): Promise<void> {
    const run = this.installRun;
    if (!run) return;
    let id = run.nextPendingId();
    while (id !== null) {
      if (this.destroyed) {
        run.abort();
        break;
      }
      const view = run.steps.find((s) => s.id === id);
      const suspended = Boolean(view?.suspendForRun);
      this.ensureSpinner();
      if (suspended) this.suspendRenderer();
      try {
        await run.runStep(id, () => this.show());
      } finally {
        if (suspended) this.resumeRenderer();
      }
      this.clearSpinner();
      if (this.destroyed) {
        run.abort();
        break;
      }
      if (run.failedStepId) {
        this.show();
        const decision = await this.waitForFailureDecision();
        id = decision === "abort" ? null : run.failedStepId;
        if (decision === "abort") run.abort();
      } else {
        id = run.nextPendingId();
      }
    }
    this.clearSpinner();
    this.phase = "done";
    this.show();
  }

  private waitForFailureDecision(): Promise<"retry" | "abort"> {
    return new Promise((resolve) => {
      this.failureDecision = { resolve };
    });
  }

  private resolveFailure(decision: "retry" | "abort"): void {
    this.failureDecision?.resolve(decision);
    this.failureDecision = null;
  }

  private suspendRenderer(): void {
    try {
      this.renderer.suspend();
    } catch {
      /* test renderer may not support suspend */
    }
  }

  private resumeRenderer(): void {
    try {
      this.renderer.resume();
    } catch {
      /* test renderer may not support resume */
    }
  }

  private ensureSpinner(): void {
    if (this.frameCallback) return;
    const cb = async (): Promise<void> => {
      this.frameTick += 1;
      if (this.frameTick % 6 === 0 && this.phase === "install") this.show();
    };
    this.frameCallback = cb;
    try {
      this.renderer.setFrameCallback(cb);
    } catch {
      this.frameCallback = null;
    }
  }

  private clearSpinner(): void {
    if (!this.frameCallback) return;
    try {
      this.renderer.removeFrameCallback(this.frameCallback);
    } catch {
      /* noop */
    }
    this.frameCallback = null;
  }

  private installScreen(): VChild {
    const run = this.installRun;
    const rows: VChild[] = (run?.steps ?? []).map((s) => {
      const glyph =
        s.status === "done"
          ? "✓"
          : s.status === "failed"
            ? "✗"
            : s.status === "running"
              ? "▶"
              : s.status === "pending"
                ? "○"
                : "–";
      const color =
        s.status === "done"
          ? C.ok
          : s.status === "failed"
            ? "#FF6B6B"
            : s.status === "running"
              ? C.accent
              : C.dim;
      const spinner =
        s.status === "running"
          ? ` ${["◐", "◓", "◑", "◒"][Math.floor(this.frameTick / 6) % 4]}`
          : "";
      return Box(
        { flexDirection: "row", gap: 1 },
        Text({ content: glyph, fg: color }),
        Text({
          content: s.title,
          fg: s.status === "done" || s.status === "failed" ? "#FFFFFF" : C.label,
        }),
        Text({ content: spinner, fg: C.accent }),
      );
    });

    const body: VChild[] = [...rows, Text({ content: " " })];

    const failed = run?.steps.find((s) => s.status === "failed");
    if (failed?.result && !failed.result.ok) {
      const r = failed.result;
      const detailLines: string[] = [];
      if (r.exitCode !== undefined && r.exitCode !== null) {
        detailLines.push(`exit code: ${r.exitCode}`);
      }
      const tail = stderrTail(r.stderrTail ?? r.detail);
      if (tail) detailLines.push(tail);
      body.push(
        Text({ content: `Failed: ${failed.title}`, fg: "#FF6B6B" }),
        ...detailLines.map((l) => Text({ content: `  ${l}`, fg: C.dim })),
        Text({ content: " " }),
      );
      this.focusRootId = "fail-select";
      const select = Select({
        id: "fail-select",
        width: WIDTH,
        height: 4,
        options: [
          { name: "Retry", description: "re-run this step", value: "retry" },
          { name: "Abort", description: "stop setup", value: "abort" },
        ],
        selectedIndex: 0,
        showDescription: true,
        selectedBackgroundColor: "#2E3A4A",
        selectedTextColor: C.accent,
        descriptionColor: C.label,
      });
      select.on(SelectRenderableEvents.ITEM_SELECTED, (index, option) => {
        void index;
        this.resolveFailure(option.value === "retry" ? "retry" : "abort");
      });
      body.push(select);
    }

    return this.shell(
      "Setup — installing",
      body,
      failed ? "↑/↓  choose   ·   Enter  confirm   ·   Esc  abort" : undefined,
    );
  }

  private doneScreen(): VChild {
    const run = this.installRun;
    const rows: VChild[] = (run?.steps ?? []).map((s) => {
      const glyph = s.status === "done" ? "✓" : "–";
      const color = s.status === "done" ? C.ok : C.dim;
      // Aborted steps keep their failed result; clamp the line to the box width.
      const note =
        s.result && !s.result.ok ? ` — ${s.result.detail.split("\n")[0]?.slice(0, 60) ?? ""}` : "";
      return Box(
        { flexDirection: "row", gap: 1 },
        Text({ content: glyph, fg: color }),
        Text({ content: `${s.title}${note}`, fg: "#FFFFFF" }),
      );
    });
    const aborted = Boolean(run?.aborted);
    return this.shell(
      aborted ? "Setup aborted" : "Setup complete",
      [
        ...rows,
        Text({ content: " " }),
        Text({
          content: aborted
            ? "Installs were aborted — partial changes may remain."
            : "All install steps finished.",
          fg: aborted ? C.accent : C.ok,
        }),
      ],
      "Enter  finish",
    );
  }

  // ── Screens ──────────────────────────────────────────────────────────

  private shell(title: string, body: VChild[], hint?: string): VChild {
    return Box(
      {
        id: SCREEN_ID,
        width: WIDTH + 4,
        borderStyle: "rounded",
        title,
        titleColor: C.title,
        padding: 1,
        flexDirection: "column",
        gap: 1,
      },
      ...body,
      ...(hint ? [Text({ content: hint, fg: C.dim })] : []),
    );
  }

  private welcome(): VChild {
    return this.shell(
      "Disk Agent setup",
      [
        Text({
          content: `v${this.ctx.version} — OpenClaw/Hermes-style personal AI agent (Pi-powered)`,
          fg: C.label,
        }),
        Text({ content: " " }),
        Text({ content: "This wizard configures your agent home, default model/provider," }),
        Text({ content: "Telegram, and the Pi integrations to install." }),
        Text({ content: " " }),
        Text({
          content: "  · model & provider can be imported from Pi (~/.pi/agent/auth.json)",
          fg: C.accent,
        }),
        Text({
          content: "  · runs on Pi coding-agent, shared auth with the `pi` CLI",
          fg: C.accent,
        }),
        Text({ content: " " }),
      ],
      "Enter  continue   ·   Esc  quit",
    );
  }

  private labeledInput(
    id: string,
    label: string,
    placeholder: string,
    initial: string,
    opts?: { showExisting?: string; onEnter?: (value: string) => void },
  ): VChild {
    this.tabTargets.push(id);
    if (!this.focusRootId) this.focusRootId = id;
    const input = Input({
      id,
      placeholder,
      width: WIDTH - 16,
      value: initial,
      backgroundColor: C.inputBg,
      focusedBackgroundColor: C.inputFocusBg,
      textColor: "#FFFFFF",
      cursorColor: C.accent,
    });
    if (opts?.onEnter) {
      input.on(InputRenderableEvents.ENTER, (value: string) => {
        opts.onEnter?.(value);
      });
    }
    const row = Box(
      { flexDirection: "row", gap: 1 },
      Text({ content: label.padEnd(13), fg: C.label }),
      input,
    );
    if (!opts?.showExisting) return row;
    return Box(
      { flexDirection: "column", gap: 0 },
      row,
      Text({ content: opts.showExisting, fg: C.dim }),
    );
  }

  private agentScreen(): VChild {
    const name = this.labeledInput(
      "agent-name-input",
      "Agent name:",
      "Disk",
      this.state.agentName,
      {
        onEnter: (value) => {
          this.state.agentName = value;
          this.focusId("agent-cwd-input");
        },
      },
    );
    const cwd = this.labeledInput(
      "agent-cwd-input",
      "Working dir:",
      "coding tools cwd",
      this.state.cwd,
      {
        onEnter: (value) => {
          this.state.cwd = value;
          this.next();
        },
      },
    );
    return this.shell(
      "Agent basics",
      [
        Text({
          content: "Name used in identity files (SOUL.md, IDENTITY.md) and chats.",
          fg: C.label,
        }),
        name,
        cwd,
      ],
      "Tab  next field   ·   Enter  continue   ·   Esc  back",
    );
  }

  private modelScreen(): VChild {
    if (this.state.manualModel) {
      const input = this.labeledInput(
        "model-manual-input",
        "provider/model:",
        "opencode-go/grok-4.5",
        "",
        {
          onEnter: (value) => {
            const v = value.trim();
            if (!v) return;
            this.state.model = v;
            this.state.manualModel = false;
            this.next();
          },
        },
      );
      return this.shell(
        "Model — manual",
        [
          Text({
            content:
              "Type a provider/model id (e.g. opencode-go/grok-4.5, anthropic/claude-sonnet-4-20250514).",
            fg: C.label,
          }),
          input,
        ],
        "Enter  confirm   ·   Esc  back",
      );
    }

    const candidates = this.ctx.piInfo.candidates;
    const options: SelectOption[] = candidates.map((c) => ({
      name: c.label,
      description: this.describeCandidate(c),
      value: c.label,
    }));
    options.push({ name: "Manual…", description: "Type any provider/model id", value: "manual" });

    // Preselect Pi's configured default when present, else the current model.
    let defaultIdx = 0;
    if (this.ctx.piInfo.defaultProvider && this.ctx.piInfo.defaultModel) {
      const d = `${this.ctx.piInfo.defaultProvider}/${this.ctx.piInfo.defaultModel}`;
      const i = candidates.findIndex((c) => c.label === d);
      if (i >= 0) defaultIdx = i;
    } else {
      const i = candidates.findIndex((c) => c.label === this.state.model);
      if (i >= 0) defaultIdx = i;
    }

    this.focusRootId = "model-select";
    const select = Select({
      id: "model-select",
      width: WIDTH,
      height: Math.min(options.length + 1, 10),
      options,
      selectedIndex: defaultIdx === -1 ? 0 : defaultIdx,
      showDescription: true,
      showSelectionIndicator: true,
      selectedBackgroundColor: "#2E3A4A",
      selectedTextColor: C.accent,
      descriptionColor: C.label,
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index, option) => {
      void index;
      if (option.value === "manual") {
        this.state.manualModel = true;
        this.show();
      } else {
        this.state.model = option.value;
        this.next();
      }
    });

    const header: VChild[] = [
      Text({ content: "Choose the default model the agent uses.", fg: C.label }),
    ];
    if (this.ctx.piInfo.candidates.some((c) => c.source !== "preset")) {
      header.push(
        Text({
          content: "✓ candidates imported from Pi (~/.pi/agent/auth.json + models)",
          fg: C.ok,
        }),
      );
    }
    return this.shell(
      "Model & provider",
      [...header, select],
      "↑/↓  choose   ·   Enter  select   ·   Esc  back",
    );
  }

  private describeCandidate(c: PiModelCandidate): string {
    const auth = c.authed ? "✓ auth" : "no auth yet";
    const source =
      c.source === "pi-default"
        ? "Pi default"
        : c.source === "pi-auth"
          ? "Pi (auth.json)"
          : c.source === "pi-catalog"
            ? "Pi catalog"
            : "preset";
    return `${source} · ${auth}`;
  }

  private telegramScreen(): VChild {
    const existingToken = this.state.telegramToken;
    const token = this.labeledInput(
      "telegram-token-input",
      "Bot token:",
      "123456:ABC… from @BotFather",
      "",
      {
        showExisting: existingToken
          ? `existing: ${mask(existingToken)} (leave empty to keep)`
          : undefined,
        onEnter: (value) => {
          if (value.trim()) this.state.telegramToken = value.trim();
          this.focusId("telegram-owner-input");
        },
      },
    );
    const owner = this.labeledInput(
      "telegram-owner-input",
      "Owner id:",
      "your Telegram user id",
      this.state.ownerId ?? "",
      {
        onEnter: (value) => {
          if (value.trim()) this.state.ownerId = value.trim();
          this.next();
        },
      },
    );
    return this.shell(
      "Telegram (optional)",
      [
        Text({ content: "Create a bot with @BotFather (https://t.me/BotFather).", fg: C.label }),
        Text({
          content: "Leave empty to configure later — gateway still works via `disk-agent chat`.",
          fg: C.label,
        }),
        token,
        owner,
      ],
      "Tab  next field   ·   Enter  continue   ·   Esc  back",
    );
  }

  private componentScreen(
    id: string,
    title: string,
    bullets: string[],
    isSkipped: () => boolean,
  ): VChild {
    const skipNow = isSkipped();
    const options: SelectOption[] = [
      { name: "yes (recommended)", description: "install now", value: "yes" },
      { name: "no", description: "skip this step", value: "no" },
    ];
    this.focusRootId = `${id}-select`;
    const select = Select({
      id: `${id}-select`,
      width: WIDTH,
      height: 4,
      options,
      selectedIndex: skipNow ? 1 : 0,
      showDescription: false,
      selectedBackgroundColor: "#2E3A4A",
      selectedTextColor: C.accent,
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index, option) => {
      void index;
      const chosen = option.value === "yes";
      if (id === "pi") this.state.skipPi = !chosen;
      else if (id === "browser") this.state.skipBrowser = !chosen;
      this.next();
    });
    return this.shell(
      title,
      [
        ...bullets.map((b) => Text({ content: `· ${b}`, fg: C.label })),
        Text({ content: " " }),
        select,
      ],
      "↑/↓  choose   ·   Enter  continue   ·   Esc  back",
    );
  }

  private authScreen(): VChild {
    const options: SelectOption[] = [
      {
        name: "opencode-go",
        description: "OpenCode Go subscription (API key, opencode.ai)",
        value: "opencode-go",
      },
      { name: "skip", description: "defer — run `disk-agent login` later", value: "skip" },
    ];
    this.focusRootId = "auth-select";
    const select = Select({
      id: "auth-select",
      width: WIDTH,
      height: 4,
      options,
      selectedIndex: 0,
      showDescription: true,
      selectedBackgroundColor: "#2E3A4A",
      selectedTextColor: C.accent,
      descriptionColor: C.label,
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index, option) => {
      void index;
      if (option.value === "skip") {
        this.state.skipLogin = true;
        this.state.loginProvider = undefined;
      } else {
        this.state.skipLogin = false;
        this.state.loginProvider = option.value as "opencode-go";
      }
      this.next();
    });
    return this.shell(
      "Authenticate",
      [
        Text({
          content: "Credentials are stored in ~/.pi/agent/auth.json, shared with the `pi` CLI.",
          fg: C.label,
        }),
        ...this.authStatusLines(),
        select,
      ],
      "↑/↓  choose   ·   Enter  continue   ·   Esc  back",
    );
  }

  private authStatusLines(): VChild[] {
    const auth = this.ctx.auth;
    if (!auth) return [];
    const parts: string[] = [];
    if (auth.providers.length) parts.push(`auth.json: ${auth.providers.join(", ")}`);
    if (auth.envKeys.length) parts.push(`env: ${auth.envKeys.join(", ")}`);
    if (!parts.length) {
      return [
        Text({ content: "No credentials found yet — you'll be asked to log in.", fg: C.dim }),
      ];
    }
    return [Text({ content: `Already authenticated — ${parts.join(" · ")}`, fg: C.ok })];
  }

  private summary(): VChild {
    const s = this.state;
    const rows: Array<[string, string]> = [
      ["Agent name", s.agentName.trim() || "Disk"],
      ["Model", s.model?.trim() || "(default)"],
      ["Working dir", s.cwd.trim() || "(default)"],
      ["Telegram", s.telegramToken?.trim() ? `configured (${mask(s.telegramToken)})` : "not set"],
      ["Owner", s.ownerId?.trim() || "—"],
      ["Pi CLI + extensions", s.skipPi ? "skip" : "install"],
      ["agent-browser", s.skipBrowser ? "skip" : "install + Chrome"],
      ["Auth", s.skipLogin ? "skip" : String(s.loginProvider ?? "opencode-go")],
    ];
    return this.shell(
      "Review & run",
      [
        ...rows.map(([label, value]) =>
          Box(
            { flexDirection: "row", gap: 1 },
            Text({ content: `${label.padEnd(18)}`, fg: C.label }),
            Text({ content: value, fg: "#FFFFFF" }),
          ),
        ),
        Text({ content: " " }),
        Text({ content: "Installs run inside the wizard with live status.", fg: C.dim }),
      ],
      "Enter  run setup   ·   Esc  back",
    );
  }
}

function mask(secret: string): string {
  if (secret.length > 12) return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
  if (secret.length > 4) return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
  return "••••";
}

export type { PiModelInfo };
export { collectPiModels };
