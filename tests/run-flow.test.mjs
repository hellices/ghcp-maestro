import { test } from "node:test";
import assert from "node:assert/strict";
import { failRun, completeRun } from "../core/run-flow.mjs";
import { ensureRunController, releaseRun } from "../core/run-registry.mjs";

function fakeSession() {
  const logs = [];
  return { logs, log: (msg, opts) => logs.push([msg, opts]) };
}

function fakeRun() {
  const calls = [];
  return { calls, patchManifest: (p) => calls.push(p) };
}

test("failRun marks the run errored, logs at error level, and returns the run", async () => {
  const session = fakeSession();
  const run = fakeRun();
  const returned = await failRun(session, run, "boom");
  assert.equal(returned, run);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].status, "error");
  assert.ok(typeof run.calls[0].finishedAt === "number" && run.calls[0].finishedAt > 0);
  assert.deepEqual(session.logs, [["boom", { level: "error" }]]);
});

test("failRun merges extra manifest fields into the error patch", async () => {
  const session = fakeSession();
  const run = fakeRun();
  await failRun(session, run, "boom", { tokensUsed: 123 });
  assert.equal(run.calls[0].tokensUsed, 123);
  assert.equal(run.calls[0].status, "error");
});

test("failRun extraPatch cannot override the terminal status or finishedAt", async () => {
  const session = fakeSession();
  const run = fakeRun();
  await failRun(session, run, "boom", { status: "stopped", finishedAt: 0 });
  assert.equal(run.calls[0].status, "error");
  assert.ok(run.calls[0].finishedAt > 0);
});

test("failRun patches the manifest before logging", async () => {
  const order = [];
  const session = { log: () => order.push("log") };
  const run = { patchManifest: () => order.push("patch") };
  await failRun(session, run, "x");
  assert.deepEqual(order, ["patch", "log"]);
});

test("failRun tolerates a missing run handle (returns it unchanged)", async () => {
  const session = fakeSession();
  const returned = await failRun(session, undefined, "no run");
  assert.equal(returned, undefined);
  assert.deepEqual(session.logs, [["no run", { level: "error" }]]);
});

test("failRun awaits an async patchManifest before logging", async () => {
  const order = [];
  const session = { log: () => order.push("log") };
  const run = {
    patchManifest: async () => {
      await Promise.resolve();
      order.push("patch");
    },
  };
  await failRun(session, run, "x");
  assert.deepEqual(order, ["patch", "log"]);
});

test("failRun still logs the original error when patchManifest rejects", async () => {
  const logs = [];
  const session = { log: (msg, opts) => logs.push([msg, opts]) };
  const run = {
    patchManifest: async () => {
      throw new Error("disk full");
    },
  };
  // Must not throw, must still log, and must return the run.
  const returned = await failRun(session, run, "original failure");
  assert.equal(returned, run);
  assert.deepEqual(logs, [["original failure", { level: "error" }]]);
});

test("completeRun completes the run and releases its registry controller", async () => {
  const before = ensureRunController("rf-complete-ok");
  const calls = [];
  await completeRun({ runId: "rf-complete-ok", complete: () => calls.push("complete") });
  assert.deepEqual(calls, ["complete"]);
  // A fresh controller after the call proves the old entry was released.
  const after = ensureRunController("rf-complete-ok");
  assert.notEqual(after, before);
  releaseRun("rf-complete-ok");
});

test("completeRun releases the controller even when complete() rejects", async () => {
  const before = ensureRunController("rf-complete-err");
  await assert.rejects(
    () =>
      completeRun({
        runId: "rf-complete-err",
        complete: async () => {
          throw new Error("disk full");
        },
      }),
    /disk full/,
  );
  assert.notEqual(ensureRunController("rf-complete-err"), before);
  releaseRun("rf-complete-err");
});

test("completeRun tolerates a run handle without runId", async () => {
  const calls = [];
  await completeRun({ complete: () => calls.push("complete") });
  assert.deepEqual(calls, ["complete"]);
});
