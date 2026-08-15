/**
 * Pure install-step state machine for the setup wizard.
 *
 * No OpenTUI imports and no console/process side effects — the wizard owns
 * rendering (including renderer suspend/resume), `setup.ts` owns building the
 * step definitions. Unit-testable under any Node (`npm test`).
 */

export type InstallStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

export interface StepResult {
  ok: boolean;
  detail: string;
  /** Process exit code when the step ran a child process. */
  exitCode?: number | null;
  /** Tail of stderr for failure display. */
  stderrTail?: string;
}

export interface InstallStep {
  id: string;
  title: string;
  /** Suspend the renderer (leave the alternate screen) while this step runs. */
  suspendForRun?: boolean;
  run: () => Promise<StepResult>;
}

export interface StepView {
  id: string;
  title: string;
  status: InstallStepStatus;
  result?: StepResult;
  /** Run attempts including retries. */
  attempts: number;
  suspendForRun: boolean;
}

export interface InstallRunController {
  steps: StepView[];
  aborted: boolean;
  /** Id of the step that failed and is waiting for retry/abort, if any. */
  failedStepId: string | null;
  /** True when no step is pending/running/failed (all terminal). */
  readonly allDone: boolean;
  markRunning(id: string): void;
  markDone(id: string, result: StepResult): void;
  markFailed(id: string, result: StepResult): void;
  /** Mark a step skipped (user chose to skip it) — its run is never invoked. */
  skip(id: string): void;
  /** Terminal-mark all remaining pending steps as aborted. */
  abort(): void;
  canRetry(id: string): boolean;
  canAbort(id: string): boolean;
  /** Run one step to completion. onUpdate fires after each transition. */
  runStep(id: string, onUpdate?: () => void): Promise<StepView>;
  /** First pending step id, or null. */
  nextPendingId(): string | null;
}

/** Create a controller over the given step definitions. */
export function createInstallRun(steps: InstallStep[]): InstallRunController {
  const defs = new Map(steps.map((s) => [s.id, s]));
  const views: StepView[] = steps.map((s) => ({
    id: s.id,
    title: s.title,
    status: "pending",
    attempts: 0,
    suspendForRun: Boolean(s.suspendForRun),
  }));

  const view = (id: string): StepView => {
    const v = views.find((s) => s.id === id);
    if (!v) throw new Error(`install run: unknown step "${id}"`);
    return v;
  };

  const controller: InstallRunController = {
    steps: views,
    aborted: false,
    failedStepId: null,

    get allDone(): boolean {
      return views.every(
        (s) => s.status !== "pending" && s.status !== "running" && s.status !== "failed",
      );
    },

    markRunning(id) {
      const v = view(id);
      v.status = "running";
      v.attempts += 1;
      controller.failedStepId = null;
    },

    markDone(id, result) {
      const v = view(id);
      v.status = "done";
      v.result = result;
    },

    markFailed(id, result) {
      const v = view(id);
      v.status = "failed";
      v.result = result;
      controller.failedStepId = id;
    },

    skip(id) {
      const v = view(id);
      if (v.status !== "pending") return;
      v.status = "skipped";
    },

    abort() {
      controller.aborted = true;
      for (const v of views) {
        if (v.status === "pending" || v.status === "failed") {
          v.status = "aborted";
        }
      }
      controller.failedStepId = null;
    },

    canRetry(id) {
      return view(id).status === "failed";
    },

    canAbort(id) {
      return view(id).status === "failed";
    },

    async runStep(id, onUpdate) {
      const def = defs.get(id);
      if (!def) throw new Error(`install run: unknown step "${id}"`);
      controller.markRunning(id);
      onUpdate?.();
      let result: StepResult;
      try {
        result = await def.run();
      } catch (err) {
        result = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (result.ok) controller.markDone(id, result);
      else controller.markFailed(id, result);
      onUpdate?.();
      return view(id);
    },

    nextPendingId() {
      return views.find((s) => s.status === "pending")?.id ?? null;
    },
  };

  return controller;
}

/** Last `maxLines` lines of a text block (failure display). */
export function stderrTail(text: string | undefined, maxLines = 8): string {
  if (!text) return "";
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines
    .slice(-maxLines)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l))
    .join("\n");
}
