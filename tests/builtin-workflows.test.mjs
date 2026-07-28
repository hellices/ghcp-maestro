import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinWorkflows } from "../core/builtin-workflows.mjs";

// A deterministic in-process adapter: the plan agent returns a valid 3-entry
// JSON plan; every other agent echoes a per-agent line. Lets the extracted
// workflows run end-to-end under `node --test` with no live Copilot CLI.
function testAdapter() {
  return {
    name: "test",
    async invoke(spec) {
      if (spec.agent === "plan") {
        return {
          text: JSON.stringify([
            { agent: "a", prompt: "pa" },
            { agent: "b", prompt: "pb" },
            { agent: "c", prompt: "pc" },
          ]),
        };
      }
      return { text: `out-${spec.agent}` };
    },
  };
}

/** Fake host session collecting logs; no elicitation capability (non-interactive). */
function fakeSession() {
  const logs = [];
  return {
    logs,
    capabilities: {},
    log: async (msg) => {
      logs.push(String(msg));
    },
  };
}

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-wf-"));
  const prevData = process.env.GHCP_MAESTRO_DATA_DIR;
  const prevMon = process.env.GHCP_MAESTRO_NO_MONITOR;
  process.env.GHCP_MAESTRO_DATA_DIR = dir;
  process.env.GHCP_MAESTRO_NO_MONITOR = "1";
  try {
    return await fn();
  } finally {
    if (prevData === undefined) delete process.env.GHCP_MAESTRO_DATA_DIR;
    else process.env.GHCP_MAESTRO_DATA_DIR = prevData;
    if (prevMon === undefined) delete process.env.GHCP_MAESTRO_NO_MONITOR;
    else process.env.GHCP_MAESTRO_NO_MONITOR = prevMon;
    await rm(dir, { recursive: true, force: true });
  }
}

test("hello workflow runs both phases and completes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runHelloWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runHelloWorkflow(session);
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /hello workflow complete \(4 agents across 2 phases\)/.test(l)));
    assert.ok(session.logs.some((l) => /phase=explore agents=3/.test(l)));
    assert.ok(session.logs.some((l) => /phase=synth agents=1/.test(l)));
  });
});

test("brainstorm workflow runs 4 lenses + synth and completes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runBrainstormWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runBrainstormWorkflow(session, "a test topic");
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /phase=explore agents=4/.test(l)));
    assert.ok(session.logs.some((l) => /brainstorm complete — 5 agents across 2 phases/.test(l)));
  });
});

test("task workflow plans, fans out, and synthesizes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /plan produced 3 subtask\(s\): a, b, c/.test(l)));
    assert.ok(session.logs.some((l) => /phase=explore agents=3/.test(l)));
    assert.ok(session.logs.some((l) => /task workflow complete — 5 agents across 3 phases/.test(l)));
  });
});

test("task workflow fails cleanly when the plan is unparseable", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    // Adapter whose plan agent never returns valid JSON → plan + retry both fail.
    const badAdapter = () => ({
      name: "bad",
      async invoke() {
        return { text: "not json at all" };
      },
    });
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: badAdapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "error");
    assert.ok(session.logs.some((l) => /plan retry also unparseable/.test(l)));
  });
});

test("task workflow logs a run-size estimate before the gate", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    await runTaskWorkflow(session, "do the thing");
    assert.ok(session.logs.some((l) => /est\. run size: medium \(5 agents incl\. plan\+synth\)/.test(l)));
  });
});

test("task workflow warns about large fan-outs at the gate", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: testAdapter,
      env: { GHCP_MAESTRO_LARGE_RUN_AGENTS: "3" },
    });
    await runTaskWorkflow(session, "do the thing");
    assert.ok(session.logs.some((l) => /large fan-out: 3 subtask/.test(l)));
  });
});

test("task workflow soft-stops before synth when the token budget is exceeded", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const invoked = [];
    // Every agent reports 1000 tokens; a 1500-token budget survives the plan
    // phase but is exceeded during the 3-agent explore fan-out.
    const adapter = {
      name: "tokens",
      async invoke(spec, ctx) {
        invoked.push(spec.agent);
        ctx.onProgress?.({ state: "running", tokens: 1000 });
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing", { budgetTokens: 1500 });
    assert.equal(run.manifest.status, "stopped");
    assert.ok(!invoked.includes("synth"), "synth must not run after the budget is blown");
    assert.ok(session.logs.some((l) => /budget/.test(l) && /stopped/.test(l)));
    assert.ok(session.logs.some((l) => /maestro-resume/.test(l)));
  });
});

test("task workflow reports and persists token usage even without a budget", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    // Every agent reports 1000 tokens but no budget is set: nothing is skipped,
    // the run completes, and the aggregate is still reported and persisted.
    const adapter = {
      name: "tokens",
      async invoke(spec, ctx) {
        ctx.onProgress?.({ state: "running", tokens: 1000 });
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    // 5 agents (plan + 3 explore + synth) × 1000 tokens each.
    assert.equal(run.manifest.tokensUsed, 5000);
    assert.ok(session.logs.some((l) => /task workflow complete —.*tokens=5000(?!\/)/.test(l)));
  });
});

// --- DAG plans (#21) ---------------------------------------------------------

test("task workflow runs dependsOn subtasks in layers with augmented prompts", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const prompts = new Map();
    const adapter = {
      name: "dag",
      async invoke(spec) {
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb", dependsOn: ["a"] },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        prompts.set(spec.agent, spec.prompt);
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    // b's prompt is augmented with a's output; a and c stay untouched.
    assert.match(prompts.get("b"), /^pb/);
    assert.match(prompts.get("b"), /Dependency outputs/);
    assert.match(prompts.get("b"), /out-a/);
    assert.equal(prompts.get("a"), "pa");
    assert.equal(prompts.get("c"), "pc");
    assert.ok(session.logs.some((l) => /task workflow complete — 5 agents across 3 phases/.test(l)));
  });
});

test("task workflow skips dependents of failed subtasks without invoking them", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const invoked = [];
    const adapter = {
      name: "dag-fail",
      async invoke(spec) {
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb", dependsOn: ["a"] },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        invoked.push(spec.agent);
        if (spec.agent === "a") throw new Error("a always fails");
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: () => adapter,
      env: { GHCP_MAESTRO_RETRIES: "0" },
    });
    const run = await runTaskWorkflow(session, "do the thing");
    // b is never invoked; c and synth still run, so the run completes.
    assert.ok(!invoked.includes("b"), `b must not be invoked, got: ${invoked.join(", ")}`);
    assert.ok(invoked.includes("c"));
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /explore\/b .*skipped/.test(l) || /skipped.*dependency/.test(l)));
    // The skipped record is persisted so /maestro-resume reruns it.
    const rec = await run.readAgent("explore-1-b");
    assert.equal(rec.status, "skipped");
  });
});

test("gate deselecting a dependency skips its dependents instead of crashing", async () => {
  await withTempDataDir(async () => {
    // Interactive session whose approval dialog deselects subtask 0 ("a") and
    // keeps "b" (dependsOn a) and "c" — the DAG must degrade to skipping b.
    const logs = [];
    const session = {
      logs,
      capabilities: { ui: { elicitation: true } },
      ui: {
        elicitation: async () => ({ action: "accept", content: { subtasks: ["1", "2"] } }),
      },
      log: async (msg) => {
        logs.push(String(msg));
      },
    };
    const invoked = [];
    const adapter = {
      name: "dag-gate",
      async invoke(spec) {
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb", dependsOn: ["a"] },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        invoked.push(spec.agent);
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    assert.ok(!invoked.includes("a"), "a was deselected at the gate");
    assert.ok(!invoked.includes("b"), "b depends on the deselected a");
    assert.ok(invoked.includes("c"));
    assert.ok(logs.some((l) => /explore\/b skipped — dependency "a"/.test(l)));
  });
});

// --- Partial-failure disclosure (#22) ----------------------------------------

test("task workflow logs a coverage line and feeds failures to synth", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    let synthPrompt = "";
    const adapter = {
      name: "partial",
      async invoke(spec) {
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        if (spec.agent === "b") throw new Error("b always fails");
        if (spec.agent === "synth") synthPrompt = spec.prompt;
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: () => adapter,
      env: { GHCP_MAESTRO_RETRIES: "0" },
    });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /coverage: 2\/3 subtasks ok \(1 error\)/.test(l)));
    assert.match(synthPrompt, /## b \(FAILED: error\)/);
    assert.match(synthPrompt, /state explicitly which angles are missing/);
  });
});
