import { test } from "node:test";
import assert from "node:assert/strict";
import { startPhaseMonitor } from "../core/phase-monitor.mjs";

function fakeRun() {
  const writes = [];
  return {
    writes,
    writeProgress: (snap) => {
      writes.push(snap);
      return Promise.resolve();
    },
  };
}

test("returns null when monitoring is disabled", () => {
  const run = fakeRun();
  const monitor = startPhaseMonitor({
    runId: "run-x",
    run,
    phase: "plan",
    specs: [{ id: "plan", agent: "plan" }],
    env: { GHCP_MAESTRO_NO_MONITOR: "1" },
  });
  assert.equal(monitor, null);
  assert.equal(run.writes.length, 0);
});

test("records a pending snapshot immediately on phase entry", () => {
  const run = fakeRun();
  const monitor = startPhaseMonitor({
    runId: "run-x",
    run,
    phase: "plan",
    specs: [{ id: "plan", agent: "plan" }],
    env: {},
    now: () => 1000,
  });
  assert.ok(monitor);
  // The phase-entry flush must persist before any agent has produced output,
  // so /maestros <runId> shows something the instant a phase starts.
  assert.equal(run.writes.length, 1);
  const snap = run.writes[0];
  assert.equal(snap.total, 1);
  assert.equal(snap.done, 0);
  assert.equal(snap.agents[0].agent, "plan");
  assert.equal(snap.agents[0].state, "pending");
  assert.match(snap.label, /run-x plan/);
});

test("labels the snapshot with the phase name", () => {
  const run = fakeRun();
  startPhaseMonitor({
    runId: "run-x",
    run,
    phase: "synth",
    specs: [{ id: "synth", agent: "synth" }],
    env: {},
  });
  assert.match(run.writes[0].label, /run-x synth/);
});

test("the returned monitor keeps writing on progress and settle", () => {
  const run = fakeRun();
  const monitor = startPhaseMonitor({
    runId: "run-x",
    run,
    phase: "plan",
    specs: [{ id: "plan", agent: "plan" }],
    env: {},
    now: () => 1000,
  });
  const afterSeed = run.writes.length; // 1 (the entry flush)
  monitor.onProgress({ specId: "plan", state: "streaming", bytes: 2048, tokens: 500 });
  monitor.settle("plan", true);
  assert.ok(run.writes.length > afterSeed);
  const last = run.writes[run.writes.length - 1];
  assert.equal(last.done, 1);
  assert.equal(last.agents[0].state, "done");
});
