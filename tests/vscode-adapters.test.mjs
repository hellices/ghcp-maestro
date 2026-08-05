import test from "node:test";
import assert from "node:assert/strict";
import { createVsCodeLogPort } from "../vscode-extension/adapters/vscode-log-port.mjs";
import { createVsCodeCancellationPort } from "../vscode-extension/adapters/vscode-cancellation-port.mjs";
import { createCopilotRuntime } from "../vscode-extension/adapters/copilot-runtime.mjs";
import { buildSynthPrompt } from "../core/synth.mjs";

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
      return { status: "ok", output: { text: '[{"agent":"a","prompt":"p"}]' } };
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
    buildSynthPrompt,
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

// --- VS Code write-mode rejection (re-review #1) ----------------------------

test("copilot runtime rejects --write before plan spawn", async () => {
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async () => assert.fail("spawn must not be called when --write is used"),
    buildPlanPrompt: (t) => t,
    parseAndValidatePlan: () => [],
  });
  await assert.rejects(
    () => runtime.planTask({ subcommand: "task", args: "--write audit the API" }),
    /--write.*CLI/i,
  );
});

test("copilot runtime rejects --allow-dirty before plan spawn", async () => {
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async () => assert.fail("spawn must not be called when --allow-dirty is used"),
    buildPlanPrompt: (t) => t,
    parseAndValidatePlan: () => [],
  });
  await assert.rejects(
    () => runtime.planTask({ subcommand: "task", args: "--allow-dirty audit the API" }),
    /--allow-dirty.*CLI/i,
  );
});

test("brainstorm empty input says topic is required, not task description", async () => {
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async () => assert.fail("spawn must not be called"),
    buildPlanPrompt: (t) => t,
    parseAndValidatePlan: () => [],
  });
  await assert.rejects(
    () => runtime.planTask({ subcommand: "brainstorm", args: "" }),
    /topic is required/i,
  );
});

test("brainstorm subcommand uses raw args without parseTaskOptions", async () => {
  let receivedTask = null;
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async () => ({
      status: "ok",
      output: { text: '[{"agent":"a","prompt":"p"},{"agent":"b","prompt":"q"},{"agent":"c","prompt":"r"}]' },
    }),
    buildPlanPrompt: (task) => { receivedTask = task; return `PLAN: ${task}`; },
    parseAndValidatePlan: (text) => JSON.parse(text),
  });
  const plan = await runtime.planTask({ subcommand: "brainstorm", args: "future of AI" });
  assert.equal(receivedTask, "future of AI");
  assert.equal(plan.task, "future of AI");
  assert.equal(plan.concurrency, undefined, "brainstorm must not set concurrency");
});

// --- VS Code scaling parity (re-review #2) -----------------------------------

test("copilot runtime planTask with --agents 12 --concurrency 2 forwards sizing", async () => {
  let planPromptSizing = null;
  let parseOpts = null;
  const runtime = createCopilotRuntime({
    createAdapter: () => ({ name: "fake", invoke: async () => ({}) }),
    spawn: async () => ({
      status: "ok",
      output: { text: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ agent: `a${i}`, prompt: `p${i}` }))) },
    }),
    buildPlanPrompt: (task, _pe, _pr, _rb, _wm, sizing) => {
      planPromptSizing = sizing;
      return `PLAN: ${task}`;
    },
    parseAndValidatePlan: (text, opts) => {
      parseOpts = opts;
      return JSON.parse(text);
    },
    defaultModel: "gpt-5",
  });
  const plan = await runtime.planTask({ subcommand: "task", args: "--agents 12 --concurrency 2 audit the API" });
  assert.equal(plan.task, "audit the API");
  assert.deepEqual(planPromptSizing, { agentCount: 12 });
  assert.deepEqual(parseOpts, { agentCount: 12 });
  assert.equal(plan.concurrency, 2);
  assert.equal(plan.agents.length, 12);
});
