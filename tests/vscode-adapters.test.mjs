import test from "node:test";
import assert from "node:assert/strict";
import { createVsCodeLogPort } from "../vscode-extension/adapters/vscode-log-port.mjs";
import { createVsCodeCancellationPort } from "../vscode-extension/adapters/vscode-cancellation-port.mjs";
import { createCopilotRuntime } from "../vscode-extension/adapters/copilot-runtime.mjs";

test("log port writes leveled markdown to the stream", () => {
  const out = [];
  const port = createVsCodeLogPort({ stream: { markdown: (m) => out.push(m) } });
  port.info("hi");
  port.warn("careful");
  port.error("nope");
  assert.match(out[0], /maestro: hi/);
  assert.match(out[1], /⚠️ maestro: careful/);
  assert.match(out[2], /❌ maestro: nope/);
});

test("cancellation port reflects token state and forwards subscription", () => {
  let cb = null;
  const token = { isCancellationRequested: false, onCancellationRequested: (fn) => (cb = fn) };
  const port = createVsCodeCancellationPort(token);
  assert.equal(port.isCancelled(), false);
  let fired = false;
  port.onCancel(() => (fired = true));
  cb();
  assert.equal(fired, true);
  token.isCancellationRequested = true;
  assert.equal(port.isCancelled(), true);
});

test("cancellation port tolerates a missing token", () => {
  const port = createVsCodeCancellationPort(undefined);
  assert.equal(port.isCancelled(), false);
  assert.doesNotThrow(() => port.onCancel(() => {}));
});

test("copilot runtime planTask spawns a plan agent and parses specs", async () => {
  const spawned = [];
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async (spec) => {
      spawned.push(spec);
      return { output: { text: '[{"agent":"a","prompt":"p"}]' } };
    },
    buildPlanPrompt: (task) => `PLAN: ${task}`,
    parseAndValidatePlan: (text) => JSON.parse(text),
    defaultModel: "gpt-5",
  });
  const plan = await runtime.planTask({ subcommand: "task", args: "build X" });
  assert.equal(spawned[0].prompt, "PLAN: build X");
  assert.equal(plan.task, "build X");
  assert.equal(plan.agents[0].agent, "a");
  assert.equal(plan.agents[0].model, "gpt-5");
});

test("copilot runtime runAgent delegates to spawn with progress + signal", async () => {
  let received = null;
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async (spec, opts) => {
      received = { spec, opts };
      return { id: spec.id, status: "ok", output: { text: "done" } };
    },
    buildPlanPrompt: (t) => t,
    parseAndValidatePlan: () => [],
  });
  const onProgress = () => {};
  const signal = new AbortController().signal;
  const res = await runtime.runAgent({ id: "a1", prompt: "p" }, { onProgress, signal });
  assert.equal(res.status, "ok");
  assert.equal(received.opts.onProgress, onProgress);
  assert.equal(received.opts.signal, signal);
});

test("copilot runtime synthesize merges subtask outputs into one spawn", async () => {
  let synthSpec = null;
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async (spec) => {
      synthSpec = spec;
      return { output: { text: "merged answer" } };
    },
    buildPlanPrompt: (t) => t,
    parseAndValidatePlan: () => [],
    defaultModel: "gpt-5",
  });
  const out = await runtime.synthesize({
    task: "build X",
    results: [
      { id: "a1", spec: { agent: "a1" }, output: { text: "part one" } },
      { id: "a2", spec: { agent: "a2" }, output: { text: "part two" } },
    ],
  });
  assert.equal(out, "merged answer");
  assert.match(synthSpec.prompt, /part one/);
  assert.match(synthSpec.prompt, /part two/);
  assert.equal(synthSpec.agent, "synth");
});
