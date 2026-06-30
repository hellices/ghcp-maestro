import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitor, renderDashboard, renderSummary } from "../extensions/ghcp-maestro/runtime/monitor.mjs";

// Deterministic clock + captured render output.
function harness(throttleMs = 500) {
  let t = 1000;
  const renders = [];
  const monitor = createMonitor({
    label: "ghcp-maestro/run1 explore",
    render: (text) => renders.push(text),
    now: () => t,
    throttleMs,
  });
  return { monitor, renders, tick: (ms) => { t += ms; }, at: (ms) => { t = ms; } };
}

test("seed lists every agent as pending in the dashboard", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  const out = monitor.format();
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.match(out, /0\/2 done/);
});

test("a state transition renders immediately", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "running" });
  assert.equal(renders.length, 1);
  assert.match(renders[0], /alpha/);
});

test("streaming deltas are throttled to one render per interval", () => {
  const { monitor, renders, tick } = harness(500);
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 100 }); // first: renders
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 200 }); // within window: dropped
  assert.equal(renders.length, 1);
  tick(600);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 300 }); // window elapsed: renders
  assert.equal(renders.length, 2);
});

test("settle marks done/failed and updates the done count", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.settle("e0", true);
  monitor.settle("e1", false);
  const out = monitor.format();
  assert.match(out, /2\/2 done/);
  assert.match(out, /alpha/);
  assert.match(out, /✓/);
  assert.match(out, /✗/);
  assert.equal(renders.length, 2); // settle always renders
});

test("flush forces a render even with no new progress", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  const before = renders.length;
  monitor.flush();
  assert.equal(renders.length, before + 1);
});

test("streamed bytes are shown once known", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 2048 });
  assert.match(monitor.format(), /2(\.0)?\s?KB/);
});

test("tokens accumulate per agent and sum into the phase header", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.onProgress({ specId: "e0", state: "running", tokens: 1000 });
  monitor.onProgress({ specId: "e0", state: "streaming", tokens: 500 }); // alpha: 1500
  monitor.onProgress({ specId: "e1", state: "running", tokens: 2000 }); // beta: 2000
  const out = monitor.format();
  // per-phase total 3500 in the header, abbreviated to "3.5K tok"
  assert.match(out, /3\.5K tok/);
});

test("an unknown specId is ignored, never throws", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  assert.doesNotThrow(() => monitor.onProgress({ specId: "nope", state: "running" }));
});

test("snapshot captures per-agent state, tokens and totals", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 2048, tokens: 1500 });
  monitor.settle("e1", true);
  const snap = monitor.snapshot();
  assert.equal(snap.total, 2);
  assert.equal(snap.done, 1); // beta settled
  assert.equal(snap.totalTokens, 1500);
  const alpha = snap.agents.find((a) => a.specId === "e0");
  assert.equal(alpha.state, "streaming");
  assert.equal(alpha.bytes, 2048);
  assert.equal(alpha.tokens, 1500);
  assert.equal(typeof alpha.elapsedMs, "number");
});

test("renderDashboard/renderSummary are pure over a snapshot", () => {
  const snap = {
    label: "run-x explore",
    agents: [{ specId: "e0", agent: "alpha", state: "done", elapsedMs: 1000, bytes: 0, tokens: 0 }],
    done: 1, total: 1, maxElapsedMs: 1000, totalTokens: 0, updatedAt: 0,
  };
  const dash = renderDashboard(snap);
  assert.match(dash, /run-x explore/);
  assert.match(dash, /1\/1 done/);
  assert.match(dash, /alpha/);
  const sum = renderSummary(snap);
  assert.match(sum, /1\/1 done/);
  assert.equal(sum.includes("\n"), false); // one line
});

test("the render sink receives both text and snapshot", () => {
  const t = 1000;
  const calls = [];
  const monitor = createMonitor({
    label: "run-x explore",
    render: (text, snap) => calls.push({ text, snap }),
    now: () => t,
  });
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "running" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /alpha/);
  assert.equal(calls[0].snap.total, 1);
  assert.equal(calls[0].snap.agents[0].agent, "alpha");
});
