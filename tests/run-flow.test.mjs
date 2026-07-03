import { test } from "node:test";
import assert from "node:assert/strict";
import { failRun } from "../core/run-flow.mjs";

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
  assert.deepEqual(run.calls, [{ status: "error" }]);
  assert.deepEqual(session.logs, [["boom", { level: "error" }]]);
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
