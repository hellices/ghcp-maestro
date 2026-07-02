import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeBridge } from "../vscode-extension/runtime-bridge.mjs";

function fakeDeps(overrides = {}) {
  const events = [];
  const calls = { runAgent: [] };
  const deps = {
    emit: (e) => events.push(e),
    planTask: async () => ({
      task: "T",
      agents: [
        { id: "a1", agent: "a1", prompt: "p1", model: "m1" },
        { id: "a2", agent: "a2", prompt: "p2", model: "m1" },
      ],
    }),
    runAgent: async (spec) => {
      calls.runAgent.push(spec);
      return { id: spec.id, spec, status: "ok", output: { text: `out-${spec.id}` }, startedAt: 1, finishedAt: 3 };
    },
    now: () => 1,
    newRunId: () => "run-1",
    ...overrides,
  };
  return { deps, events, calls };
}

const types = (events) => events.map((e) => e.type);

test("runCommand emits the full run lifecycle in order", async () => {
  const { deps, events } = fakeDeps();
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "task", args: "do a thing" });

  const t = types(events);
  assert.equal(t[0], "run.started");
  assert.ok(t.includes("phase.started"));
  assert.equal(t.filter((x) => x === "agent.started").length, 2);
  assert.equal(t.filter((x) => x === "agent.finished").length, 2);
  assert.equal(t[t.length - 1], "run.finished");
});

test("agent.started carries prompt/model and agent.finished carries output", async () => {
  const { deps, events } = fakeDeps();
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "task", args: "x" });

  const started = events.find((e) => e.type === "agent.started" && e.agentId === "a1");
  assert.equal(started.payload.prompt, "p1");
  assert.equal(started.payload.model, "m1");
  const finished = events.find((e) => e.type === "agent.finished" && e.agentId === "a1");
  assert.equal(finished.payload.status, "ok");
  assert.equal(finished.payload.output, "out-a1");
});

test("run.finished reports error when any agent fails", async () => {
  const { deps, events } = fakeDeps({
    runAgent: async (spec) =>
      spec.id === "a2"
        ? { id: spec.id, spec, status: "error", error: "boom", startedAt: 1, finishedAt: 2 }
        : { id: spec.id, spec, status: "ok", output: { text: "ok" }, startedAt: 1, finishedAt: 2 },
  });
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "task", args: "x" });
  const last = events[events.length - 1];
  assert.equal(last.type, "run.finished");
  assert.equal(last.payload.status, "error");
});

test("tool progress is forwarded as agent.tool events", async () => {
  const { deps, events } = fakeDeps({
    runAgent: async (spec, { onProgress }) => {
      onProgress?.({ state: "tool", tool: "read", specId: spec.id });
      return { id: spec.id, spec, status: "ok", output: { text: "ok" }, startedAt: 1, finishedAt: 2 };
    },
  });
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "task", args: "x" });
  const tools = events.filter((e) => e.type === "agent.tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].payload.tool, "read");
});

test("retryAgent reruns the scoped failed agent and emits its lifecycle only", async () => {
  const { deps, events, calls } = fakeDeps();
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "task", args: "x" });

  const before = calls.runAgent.length;
  events.length = 0;
  await bridge.retryAgent({ runId: "run-1", phase: "explore", agentId: "a1" });

  const retried = calls.runAgent[calls.runAgent.length - 1];
  assert.equal(retried.id, "a1");
  assert.equal(calls.runAgent.length, before + 1);
  const t = types(events);
  assert.deepEqual(t, ["agent.started", "agent.finished"]);
  assert.ok(events.every((e) => e.agentId === "a1"));
});

test("retryAgent on an unknown run is a no-op", async () => {
  const { deps, events } = fakeDeps();
  const bridge = createRuntimeBridge(deps);
  await bridge.retryAgent({ runId: "nope", phase: "explore", agentId: "a1" });
  assert.equal(events.length, 0);
});

test("workflows subcommand lists discovered workflows without fanning out", async () => {
  const logs = [];
  const { deps } = fakeDeps({
    listWorkflows: async () => ["deep-review", "triage"],
    runAgent: async () => assert.fail("should not fan out for workflows"),
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
  });
  const bridge = createRuntimeBridge(deps);
  await bridge.runCommand({ subcommand: "workflows", args: "" });
  assert.ok(logs.join("\n").includes("deep-review"));
});

test("cancelled run skips the synth phase and finishes as stopped, not complete", async () => {
  let cancel;
  const { deps, events } = fakeDeps({
    synthesize: async () => assert.fail("synth must not run after cancellation"),
    runAgent: async (spec) => {
      if (spec.id === "a1" && cancel) cancel(); // user hits stop mid fan-out
      return { id: spec.id, spec, status: "ok", output: { text: `out-${spec.id}` }, startedAt: 1, finishedAt: 2 };
    },
  });
  const bridge = createRuntimeBridge(deps);
  const ctx = { cancellation: { onCancel: (cb) => { cancel = cb; } } };
  const res = await bridge.runCommand({ subcommand: "task", args: "x" }, ctx);

  assert.ok(!events.some((e) => e.type === "phase.started" && e.phase === "synth"));
  assert.ok(!events.some((e) => e.type === "agent.started" && e.agentId === "synth"));
  const finals = events.filter((e) => e.type === "run.finished");
  assert.equal(finals[finals.length - 1].payload.status, "stopped");
  assert.equal(res.status, "stopped");
});
