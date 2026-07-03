import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunViewModel } from "../vscode-extension/state/run-view-model.mjs";

test("projects run -> phase -> agent hierarchy with final status", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "run.started", runId: "r1", payload: { task: "do thing" } });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: { status: "ok" } });
  const snap = vm.snapshot();
  assert.equal(snap.runs[0].id, "r1");
  assert.equal(snap.runs[0].task, "do thing");
  assert.equal(snap.runs[0].phases[0].name, "explore");
  assert.equal(snap.runs[0].phases[0].agents[0].status, "ok");
});

test("preserves insertion order of phases and agents", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "plan", agentId: "p1" });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "b" });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a" });
  const phases = vm.snapshot().runs[0].phases;
  assert.deepEqual(phases.map((p) => p.name), ["plan", "explore"]);
  assert.deepEqual(phases[1].agents.map((a) => a.id), ["b", "a"]);
});

test("agent.started records running status, prompt and model", () => {
  const vm = createRunViewModel();
  vm.apply({
    type: "agent.started",
    runId: "r1",
    phase: "explore",
    agentId: "a1",
    payload: { prompt: "find X", model: "opus" },
  });
  const agent = vm.snapshot().runs[0].phases[0].agents[0];
  assert.equal(agent.status, "running");
  assert.equal(agent.prompt, "find X");
  assert.equal(agent.model, "opus");
});

test("agent.finished records output, tokens, duration and status", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1", payload: { startedAt: 1000 } });
  vm.apply({
    type: "agent.finished",
    runId: "r1",
    phase: "explore",
    agentId: "a1",
    payload: { status: "ok", output: "ALPHA", tokens: 1234, startedAt: 1000, finishedAt: 3000 },
  });
  const agent = vm.snapshot().runs[0].phases[0].agents[0];
  assert.equal(agent.status, "ok");
  assert.equal(agent.output, "ALPHA");
  assert.equal(agent.tokens, 1234);
  assert.equal(agent.durationMs, 2000);
});

test("agent.tool events accumulate a tool trace with a running count", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.tool", runId: "r1", phase: "explore", agentId: "a1", payload: { tool: "grep", status: "ok", durationMs: 12 } });
  vm.apply({ type: "agent.tool", runId: "r1", phase: "explore", agentId: "a1", payload: { tool: "read", status: "ok", durationMs: 4 } });
  const agent = vm.snapshot().runs[0].phases[0].agents[0];
  assert.equal(agent.toolCount, 2);
  assert.deepEqual(agent.tools.map((t) => t.tool), ["grep", "read"]);
});

test("per-phase counts summarise total/done/failed/running", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: { status: "ok" } });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a2" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a2", payload: { status: "error" } });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a3" });
  const phase = vm.snapshot().runs[0].phases[0];
  assert.deepEqual(phase.counts, { total: 3, done: 1, failed: 1, running: 1 });
});

test("aborted agents count as terminal so done+failed+running equals total", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: { status: "ok" } });
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a2" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a2", payload: { status: "aborted" } });
  const c = vm.snapshot().runs[0].phases[0].counts;
  assert.equal(c.done + c.failed + c.running, c.total);
  assert.deepEqual(c, { total: 2, done: 1, failed: 1, running: 0 });
});

test("agent.finished with an unrecognised status falls back to unknown", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: {} });
  assert.equal(vm.snapshot().runs[0].phases[0].agents[0].status, "unknown");
});

test("run.finished updates run status; newest run is listed first", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "run.started", runId: "r1" });
  vm.apply({ type: "run.started", runId: "r2" });
  vm.apply({ type: "run.finished", runId: "r1", payload: { status: "complete" } });
  const snap = vm.snapshot();
  assert.deepEqual(snap.runs.map((r) => r.id), ["r2", "r1"]);
  const r1 = snap.runs.find((r) => r.id === "r1");
  assert.equal(r1.status, "complete");
});

test("subscribe fires the listener on every apply and unsubscribes cleanly", () => {
  const vm = createRunViewModel();
  let fires = 0;
  const off = vm.subscribe(() => (fires += 1));
  vm.apply({ type: "run.started", runId: "r1" });
  vm.apply({ type: "agent.started", runId: "r1", phase: "p", agentId: "a" });
  off();
  vm.apply({ type: "agent.finished", runId: "r1", phase: "p", agentId: "a", payload: { status: "ok" } });
  assert.equal(fires, 2);
});

test("agentDetail returns the full agent record for drill-down", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1", payload: { prompt: "P" } });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: { status: "error", error: "boom" } });
  const detail = vm.agentDetail("r1", "explore", "a1");
  assert.equal(detail.prompt, "P");
  assert.equal(detail.error, "boom");
  assert.equal(detail.status, "error");
});
