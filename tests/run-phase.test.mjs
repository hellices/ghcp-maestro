import test from "node:test";
import assert from "node:assert/strict";
import { runPhase } from "../core/run-phase.mjs";

/** Build a fake monitor that records every call. */
function fakeMonitor() {
  const calls = { seeded: null, progress: [], settled: [], flushed: 0 };
  return {
    calls,
    onProgress: (e) => calls.progress.push(e),
    settle: (id, ok) => calls.settled.push({ id, ok }),
    flush: () => (calls.flushed += 1),
  };
}

const RESULTS = [
  { spec: { id: "a" }, status: "ok" },
  { spec: { id: "b" }, status: "error" },
];

test("runPhase wires the monitor, settles each result, flushes, returns results in order", async () => {
  const monitor = fakeMonitor();
  let seededWith = null;
  let spawnOpts = null;
  const { results } = await runPhase([{ id: "a", agent: "a" }, { id: "b", agent: "b" }], {
    run: { id: "run" },
    runId: "run-1",
    phase: "explore",
    adapter: { name: "fake" },
    startPhaseMonitor: (o) => {
      seededWith = o;
      return monitor;
    },
    spawnAll: async (_specs, opts) => {
      spawnOpts = opts;
      return RESULTS;
    },
  });

  assert.deepEqual(results, RESULTS);
  // monitor seeded with the phase context
  assert.equal(seededWith.runId, "run-1");
  assert.equal(seededWith.phase, "explore");
  // spawnAll received adapter + runHandle + a wired onProgress
  assert.equal(spawnOpts.adapter.name, "fake");
  assert.equal(spawnOpts.runHandle.id, "run");
  assert.equal(typeof spawnOpts.onProgress, "function");
  // each result settled with its ok flag, then flushed once
  assert.deepEqual(monitor.calls.settled, [
    { id: "a", ok: true },
    { id: "b", ok: false },
  ]);
  assert.equal(monitor.calls.flushed, 1);
});

test("runPhase forwards progress events to the monitor", async () => {
  const monitor = fakeMonitor();
  await runPhase([{ id: "a", agent: "a" }], {
    run: {},
    runId: "r",
    phase: "explore",
    adapter: {},
    startPhaseMonitor: () => monitor,
    spawnAll: async (_specs, opts) => {
      opts.onProgress({ specId: "a", state: "streaming" });
      return [{ spec: { id: "a" }, status: "ok" }];
    },
  });
  assert.deepEqual(monitor.calls.progress, [{ specId: "a", state: "streaming" }]);
});

test("runPhase tolerates monitoring being disabled (null monitor)", async () => {
  let onProgress = "unset";
  const { results } = await runPhase([{ id: "a", agent: "a" }], {
    run: {},
    runId: "r",
    phase: "explore",
    adapter: {},
    startPhaseMonitor: () => null,
    spawnAll: async (_specs, opts) => {
      onProgress = opts.onProgress;
      return [{ spec: { id: "a" }, status: "ok" }];
    },
  });
  assert.equal(results.length, 1);
  // with no monitor there is no progress sink
  assert.equal(onProgress, undefined);
});

test("runPhase measures elapsed from the injected clock", async () => {
  let t = 1000;
  const { elapsedMs } = await runPhase([{ id: "a", agent: "a" }], {
    run: {},
    runId: "r",
    phase: "explore",
    adapter: {},
    now: () => (t += 250),
    startPhaseMonitor: () => null,
    spawnAll: async () => [{ spec: { id: "a" }, status: "ok" }],
  });
  // now() called once for start (1250) and once for end (1500) → 250ms
  assert.equal(elapsedMs, 250);
});

test("runPhase forwards signal and concurrency to spawnAll", async () => {
  const signal = new AbortController().signal;
  let opts = null;
  await runPhase([{ id: "a", agent: "a" }], {
    run: {},
    runId: "r",
    phase: "explore",
    adapter: {},
    signal,
    concurrency: 4,
    startPhaseMonitor: () => null,
    spawnAll: async (_specs, o) => {
      opts = o;
      return [{ spec: { id: "a" }, status: "ok" }];
    },
  });
  assert.equal(opts.signal, signal);
  assert.equal(opts.concurrency, 4);
});

test("runPhase forwards the budget tracker to spawnAll", async () => {
  const budget = { add() {}, exceeded: () => false };
  let opts = null;
  await runPhase([{ id: "a", agent: "a" }], {
    run: {},
    runId: "r",
    phase: "explore",
    adapter: {},
    budget,
    startPhaseMonitor: () => null,
    spawnAll: async (_specs, o) => {
      opts = o;
      return [{ spec: { id: "a" }, status: "ok" }];
    },
  });
  assert.equal(opts.budget, budget);
});
