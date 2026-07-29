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

// --- Model routing (#17) ------------------------------------------------------

test("task workflow routes per-label models to agent specs when routes are set", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const models = [];
    const adapter = {
      name: "route-spy",
      async invoke(spec) {
        models.push(`${spec.agent}=${spec.model ?? "(default)"}`);
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
    const run = await runTaskWorkflow(session, "do the thing", {
      modelRoutes: { "explore:*": "fast-model", synth: "premium-model" },
    });
    assert.equal(run.manifest.status, "complete");
    assert.ok(models.includes("plan=(default)"), "unrouted label keeps the adapter default");
    assert.ok(models.includes("a=fast-model"));
    assert.ok(models.includes("b=fast-model"));
    assert.ok(models.includes("c=fast-model"));
    assert.ok(models.includes("synth=premium-model"));
    assert.ok(session.logs.some((l) => /model routes: .*fast-model/.test(l)));
  });
});

test("task workflow reads model routes from GHCP_MAESTRO_MODEL_ROUTES", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const models = [];
    const adapter = {
      name: "route-spy",
      async invoke(spec) {
        models.push(spec.model);
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        return { text: "out" };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: () => adapter,
      env: { GHCP_MAESTRO_MODEL_ROUTES: '{"*":"everywhere-model"}' },
    });
    await runTaskWorkflow(session, "do the thing");
    assert.ok(models.every((m) => m === "everywhere-model"));
  });
});

test("task workflow leaves spec.model unset when no routes are configured", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const sawModelKey = [];
    const adapter = {
      name: "route-spy",
      async invoke(spec) {
        sawModelKey.push("model" in spec);
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        return { text: "out" };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    await runTaskWorkflow(session, "do the thing");
    assert.ok(sawModelKey.every((k) => k === false), "specs must not grow a model key by default");
  });
});

// --- Verify phase (#31) --------------------------------------------------------

test("task workflow runs the verify phase when opted in and feeds synth the report", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const prompts = {};
    const adapter = {
      name: "verify-spy",
      async invoke(spec) {
        prompts[spec.agent] = spec.prompt;
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        if (spec.agent === "verify") return { text: "OVERALL: 3/3 subtasks met the objective" };
        return { text: `out-${spec.agent}` };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing", { verify: true });
    assert.equal(run.manifest.status, "complete");
    assert.ok(prompts.verify, "verify agent must run");
    assert.match(prompts.verify, /verification agent/);
    assert.match(prompts.synth, /OVERALL: 3\/3 subtasks met the objective/);
    assert.ok(session.logs.some((l) => /phase=verify agents=1/.test(l)));
    assert.ok(session.logs.some((l) => /VERIFY REPORT/.test(l)));
    assert.ok(
      session.logs.some((l) => /complete — 6 agents across 4 phases .*\+ verify \+ synth/.test(l)),
    );
  });
});

test("task workflow skips verify by default and via env opts in", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const agents = [];
    const adapter = () => ({
      name: "spy",
      async invoke(spec) {
        agents.push(spec.agent);
        if (spec.agent === "plan") {
          return {
            text: JSON.stringify([
              { agent: "a", prompt: "pa" },
              { agent: "b", prompt: "pb" },
              { agent: "c", prompt: "pc" },
            ]),
          };
        }
        return { text: "out" };
      },
    });
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: adapter });
    await runTaskWorkflow(session, "do the thing");
    assert.ok(!agents.includes("verify"), "verify must be opt-in");

    agents.length = 0;
    const { runTaskWorkflow: withEnv } = createBuiltinWorkflows({
      getAdapter: adapter,
      env: { GHCP_MAESTRO_VERIFY: "1" },
    });
    await withEnv(session, "do the thing");
    assert.ok(agents.includes("verify"), "GHCP_MAESTRO_VERIFY must enable verify");
  });
});

test("task workflow survives a failed verify agent and synthesizes without a report", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    let synthPrompt = "";
    const adapter = {
      name: "verify-fail",
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
        if (spec.agent === "verify") throw new Error("verify blew up");
        if (spec.agent === "synth") {
          synthPrompt = spec.prompt;
          return { text: "final" };
        }
        return { text: "out" };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing", { verify: true });
    assert.equal(run.manifest.status, "complete");
    assert.doesNotMatch(synthPrompt, /verification agent independently judged/);
    assert.ok(
      session.logs.some((l) => /verify agent error: .*continuing to synth/.test(l)),
      "verify failure must be logged as a warning",
    );
    assert.ok(
      session.logs.some((l) => /complete — 6 agents across 4 phases/.test(l)),
      "the failed verify agent still ran and must be counted",
    );
  });
});

// --- Trace export (#32) --------------------------------------------------------

test("task workflow writes an OTel GenAI-style trace.json at completion", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const trace = JSON.parse(await readFile(join(run.runDir, "trace.json"), "utf8"));
    assert.ok(trace.traceId);
    const root = trace.spans[0];
    assert.equal(root.attributes["gen_ai.operation.name"], "invoke_workflow");
    assert.equal(root.attributes["gen_ai.conversation.id"], run.runId);
    // plan + 3 explore + synth agent spans under the root.
    const agentSpans = trace.spans.filter(
      (s) => s.attributes["gen_ai.operation.name"] === "invoke_agent",
    );
    assert.equal(agentSpans.length, 5);
    assert.ok(agentSpans.every((s) => s.parentSpanId === root.spanId));
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

test("task workflow soft-stops (not errors) when the verify agent blows the budget", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const invoked = [];
    // 1000 tokens/agent, 4500 budget: plan + 3 explore = 4000 (under the cap),
    // verify pushes it to 5000 — the run must soft-stop before synth instead of
    // failing with "synth skipped".
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
    const run = await runTaskWorkflow(session, "do the thing", {
      budgetTokens: 4500,
      verify: true,
    });
    assert.equal(run.manifest.status, "stopped");
    assert.ok(invoked.includes("verify"), "verify runs while the budget still has headroom");
    assert.ok(!invoked.includes("synth"), "synth must not run after verify blows the budget");
    assert.equal(run.manifest.tokensUsed, 5000);
    assert.ok(session.logs.some((l) => /budget/.test(l) && /stopped before synth/.test(l)));
    assert.ok(session.logs.some((l) => /maestro-resume/.test(l)));
  });
});

test("task workflow keeps tokensUsed cumulative across a budget soft-stop resume", async () => {
  await withTempDataDir(async () => {
    const makeAdapter = (invoked) => ({
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
    });
    const firstInvoked = [];
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: () => makeAdapter(firstInvoked),
    });
    const run = await runTaskWorkflow(fakeSession(), "do the thing", { budgetTokens: 1500 });
    assert.equal(run.manifest.status, "stopped");
    const firstTokens = run.manifest.tokensUsed;
    assert.ok(firstTokens > 0, "the soft-stopped run persists its spend");

    // Resume with an ample budget: cached ok agents replay for free, only the
    // remaining agents spend tokens — and the persisted total must be the sum
    // of both attempts, not just the resume delta.
    const secondInvoked = [];
    const { runTaskWorkflow: resumeTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: () => makeAdapter(secondInvoked),
    });
    const resumed = await resumeTaskWorkflow(fakeSession(), "do the thing", {
      run,
      budgetTokens: 999999,
    });
    assert.equal(resumed.manifest.status, "complete");
    assert.equal(resumed.manifest.tokensUsed, firstTokens + secondInvoked.length * 1000);
    assert.ok(
      resumed.manifest.tokensUsed > firstTokens,
      "resume must add to the prior spend, not clobber it",
    );
  });
});

test("gate abort persists token accounting, finishedAt, and a trace", async () => {
  await withTempDataDir(async () => {
    // Interactive session that cancels at the approval gate — the plan agent
    // already spent tokens, so the stopped run must keep its accounting.
    const logs = [];
    const session = {
      logs,
      capabilities: { ui: { elicitation: true } },
      ui: { elicitation: async () => ({ action: "decline" }) },
      log: async (msg) => {
        logs.push(String(msg));
      },
    };
    const adapter = {
      name: "gate-abort",
      async invoke(spec, ctx) {
        ctx.onProgress?.({ state: "running", tokens: 1000 });
        return {
          text: JSON.stringify([
            { agent: "a", prompt: "pa" },
            { agent: "b", prompt: "pb" },
            { agent: "c", prompt: "pc" },
          ]),
        };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "stopped");
    assert.equal(run.manifest.tokensUsed, 1000, "the plan agent's spend must be persisted");
    assert.ok(typeof run.manifest.finishedAt === "number" && run.manifest.finishedAt > 0);
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const trace = JSON.parse(await readFile(join(run.runDir, "trace.json"), "utf8"));
    assert.ok(trace.spans.length >= 2, "root + plan spans");
  });
});

test("task workflow persists token usage on failed runs too", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const adapter = {
      name: "synth-fails",
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
        if (spec.agent === "synth") throw new Error("synth blew up");
        return { text: "out" };
      },
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: () => adapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "error");
    // plan + 3 explore + synth attempts all reported tokens before failing.
    assert.ok(run.manifest.tokensUsed >= 5000, `expected >=5000, got ${run.manifest.tokensUsed}`);
    assert.ok(typeof run.manifest.finishedAt === "number" && run.manifest.finishedAt > 0);
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
