/**
 * Pure state-machine tests for the setup install runner — any Node.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInstallRun,
  type InstallStep,
  type InstallStepStatus,
  stderrTail,
} from "../src/setup/install-steps.js";

function fakeStep(
  id: string,
  run: InstallStep["run"],
  opts?: { title?: string; suspendForRun?: boolean },
): InstallStep {
  return { id, title: opts?.title ?? id, run, suspendForRun: opts?.suspendForRun };
}

const ok = (detail = "ok"): Awaited<ReturnType<InstallStep["run"]>> => ({
  ok: true,
  detail,
});

test("installRun: seeds all steps pending", () => {
  const run = createInstallRun([fakeStep("a", async () => ok()), fakeStep("b", async () => ok())]);
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["pending", "pending"],
  );
  assert.equal(run.aborted, false);
  assert.equal(run.allDone, false);
});

test("installRun: pending→running→done in order via runStep", async () => {
  const order: string[] = [];
  const updates: InstallStepStatus[][] = [];
  const run = createInstallRun([
    fakeStep("a", async () => {
      order.push("a");
      return ok("a ok");
    }),
    fakeStep("b", async () => {
      order.push("b");
      return ok("b ok");
    }),
  ]);

  const a = await run.runStep("a", () => updates.push(run.steps.map((s) => s.status)));
  assert.equal(a.status, "done");
  assert.equal(a.attempts, 1);
  assert.equal(a.result?.detail, "a ok");
  assert.deepEqual(updates[0], ["running", "pending"]);
  assert.deepEqual(updates[1], ["done", "pending"]);

  await run.runStep("b");
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["done", "done"],
  );
  assert.equal(run.allDone, true);
  assert.deepEqual(order, ["a", "b"]);
});

test("installRun: failed step records exitCode + stderrTail; later steps stay pending", async () => {
  const run = createInstallRun([
    fakeStep("a", async () => ({
      ok: false,
      detail: "npm install failed",
      exitCode: 1,
      stderrTail: "ERR! something broke",
    })),
    fakeStep("b", async () => ok()),
  ]);

  const a = await run.runStep("a");
  assert.equal(a.status, "failed");
  assert.equal(a.result?.exitCode, 1);
  assert.equal(a.result?.stderrTail, "ERR! something broke");
  assert.equal(run.failedStepId, "a");
  assert.equal(run.allDone, false);
  assert.equal(run.canRetry("a"), true);
  assert.equal(run.canAbort("a"), true);

  // b untouched — wizard decides policy, machine only reports
  assert.equal(run.steps[1]?.status, "pending");
  assert.equal(run.nextPendingId(), "b");
});

test("installRun: runStep catches a throwing step into a failed result", async () => {
  const run = createInstallRun([
    fakeStep("boom", async () => {
      throw new Error("exploded");
    }),
  ]);
  const v = await run.runStep("boom");
  assert.equal(v.status, "failed");
  assert.equal(v.result?.detail, "exploded");
});

test("installRun: retry re-runs only the failed step, attempts increments, done kept", async () => {
  let calls = 0;
  const run = createInstallRun([
    fakeStep("a", async () => {
      calls += 1;
      return calls === 1 ? { ok: false, detail: "first try fails" } : ok("second try ok");
    }),
    fakeStep("b", async () => ok()),
  ]);

  const first = await run.runStep("a");
  assert.equal(first.status, "failed");
  assert.equal(first.attempts, 1);

  await run.runStep("b");
  assert.equal(run.steps[1]?.status, "done");

  const retried = await run.runStep("a");
  assert.equal(retried.status, "done");
  assert.equal(retried.attempts, 2);
  assert.equal(retried.result?.detail, "second try ok");
  assert.equal(run.failedStepId, null);
  assert.equal(run.allDone, true);
});

test("installRun: abort terminal-marks remaining steps; pending run never invoked", async () => {
  let bRan = false;
  const run = createInstallRun([
    fakeStep("a", async () => ({ ok: false, detail: "fail" })),
    fakeStep("b", async () => {
      bRan = true;
      return ok();
    }),
    fakeStep("c", async () => {
      bRan = true;
      return ok();
    }),
  ]);

  await run.runStep("a");
  run.abort();

  assert.equal(run.aborted, true);
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["aborted", "aborted", "aborted"],
  );
  assert.equal(bRan, false);
  assert.equal(run.failedStepId, null);
  assert.equal(run.allDone, true);
  assert.equal(run.canRetry("a"), false);
  assert.equal(run.canAbort("a"), false);
});

test("installRun: skip marks step skipped, run never invoked", async () => {
  let ran = false;
  const run = createInstallRun([
    fakeStep("s", async () => {
      ran = true;
      return ok();
    }),
  ]);
  run.skip("s");
  assert.equal(run.steps[0]?.status, "skipped");
  assert.equal(ran, false);
  assert.equal(run.nextPendingId(), null);
  assert.equal(run.allDone, true);
});

test("installRun: zero steps resolves finished immediately", () => {
  const run = createInstallRun([]);
  assert.equal(run.allDone, true);
  assert.equal(run.nextPendingId(), null);
  assert.deepEqual(run.steps, []);
});

test("installRun: unknown step throws", () => {
  const run = createInstallRun([fakeStep("a", async () => ok())]);
  assert.throws(() => run.markRunning("nope"), /unknown step/);
});

test("stderrTail: last N lines, trims trailing whitespace, empty for undefined", () => {
  assert.equal(stderrTail(undefined), "");
  assert.equal(stderrTail(""), "");
  const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(
    stderrTail(long, 8),
    ["line 4", "line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11"].join("\n"),
  );
  assert.equal(stderrTail("  \n"), "");
});
