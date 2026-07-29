import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunRegistry } from "../core/run-registry.mjs";
import { runPhase } from "../core/run-phase.mjs";
import { dummyAdapter } from "../core/spawn.mjs";

test("ensureRunController returns the same controller per runId", () => {
  const reg = createRunRegistry();
  const a = reg.ensureRunController("r1");
  assert.equal(reg.ensureRunController("r1"), a);
  assert.notEqual(reg.ensureRunController("r2"), a);
  assert.equal(reg.size, 2);
});

test("abortRun aborts a live controller with a default reason and removes it", () => {
  const reg = createRunRegistry();
  const controller = reg.ensureRunController("r1");
  assert.equal(reg.abortRun("r1"), true);
  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason?.message), /run r1 stopped by user/);
  // Entry removed: a later resume gets a fresh, un-aborted controller.
  assert.equal(reg.ensureRunController("r1").signal.aborted, false);
});

test("abortRun returns false when this process owns no controller for the run", () => {
  const reg = createRunRegistry();
  assert.equal(reg.abortRun("ghost"), false);
  assert.equal(reg.size, 0, "abort of an unknown run must not create an entry");
});

test("releaseRun drops the entry without aborting", () => {
  const reg = createRunRegistry();
  const controller = reg.ensureRunController("r1");
  reg.releaseRun("r1");
  assert.equal(controller.signal.aborted, false);
  assert.equal(reg.size, 0);
});

test("runPhase falls back to the run registry signal so a stop aborts the phase", async () => {
  const reg = createRunRegistry();
  const slowAdapter = {
    name: "slow",
    invoke: (spec, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      }),
  };
  const phase = runPhase([{ id: "a1", agent: "a1", prompt: "p" }], {
    run: undefined,
    runId: "r1",
    phase: "explore",
    adapter: slowAdapter,
    startPhaseMonitor: () => null,
    ensureRunController: (id) => reg.ensureRunController(id),
  });
  // Let the phase start, then stop the run.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reg.abortRun("r1"), true);
  const { results } = await phase;
  assert.equal(results[0].status, "aborted");
  assert.match(results[0].error, /stopped by user/);
});

test("runPhase with an already-aborted registry signal refuses to start", async () => {
  const reg = createRunRegistry();
  reg.ensureRunController("r1");
  const controller = reg.ensureRunController("r1");
  controller.abort(new Error("run r1 stopped by user"));
  await assert.rejects(
    () =>
      runPhase([{ id: "a1", agent: "a1", prompt: "p" }], {
        run: undefined,
        runId: "r1",
        phase: "synth",
        adapter: dummyAdapter,
        startPhaseMonitor: () => null,
        ensureRunController: (id) => reg.ensureRunController(id),
      }),
    /stopped by user/,
  );
});

test("runPhase prefers an explicitly injected signal over the registry", async () => {
  const reg = createRunRegistry();
  const explicit = new AbortController();
  let seenSignal;
  const adapter = {
    name: "probe",
    async invoke(_spec, ctx) {
      seenSignal = ctx.signal;
      return { text: "ok" };
    },
  };
  await runPhase([{ id: "a1", agent: "a1", prompt: "p" }], {
    run: undefined,
    runId: "r1",
    phase: "explore",
    adapter,
    signal: explicit.signal,
    startPhaseMonitor: () => null,
    ensureRunController: (id) => reg.ensureRunController(id),
  });
  assert.equal(seenSignal, explicit.signal);
  assert.equal(reg.size, 0, "registry must not be consulted when a signal is injected");
});

test("per-agent controllers: ensure/abort scoped to one agent of one run", () => {
  const reg = createRunRegistry();
  const a1 = reg.ensureAgentController("run-1", "a1");
  assert.equal(reg.ensureAgentController("run-1", "a1"), a1, "same controller per (run, agent)");
  const a2 = reg.ensureAgentController("run-1", "a2");
  const other = reg.ensureAgentController("run-2", "a1");

  assert.equal(reg.abortAgent("run-1", "a1"), true);
  assert.equal(a1.signal.aborted, true);
  assert.equal(a2.signal.aborted, false, "sibling agent untouched");
  assert.equal(other.signal.aborted, false, "same agent id in another run untouched");
  assert.equal(reg.abortAgent("run-1", "a1"), false, "entry removed after abort");
});

test("releaseRun drops that run's agent controllers too", () => {
  const reg = createRunRegistry();
  reg.ensureAgentController("run-1", "a1");
  reg.releaseRun("run-1");
  assert.equal(reg.abortAgent("run-1", "a1"), false);
});
