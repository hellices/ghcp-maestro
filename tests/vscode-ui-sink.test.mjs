import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunViewModel } from "../vscode-extension/state/run-view-model.mjs";
import { createVsCodeUiSink } from "../vscode-extension/adapters/vscode-ui-sink.mjs";

test("sink forwards events into the view-model", () => {
  const model = createRunViewModel();
  const sink = createVsCodeUiSink({ model });
  sink.onRunEvent({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  assert.equal(model.snapshot().runs[0].phases[0].agents[0].status, "running");
});

test("sink invokes onChange after each applied event", () => {
  const model = createRunViewModel();
  let changes = 0;
  const sink = createVsCodeUiSink({ model, onChange: () => (changes += 1) });
  sink.onRunEvent({ type: "run.started", runId: "r1" });
  sink.onRunEvent({ type: "phase.started", runId: "r1", phase: "explore" });
  assert.equal(changes, 2);
});
