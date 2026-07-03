// VS Code runtime bridge — surface-neutral RuntimePort over the shared core.
//
// This module is deliberately vscode-free so it unit-tests under `node --test`.
// It owns only orchestration: turn a parsed `/maestro` command into a run, fan
// the planned agents out through an injected `runAgent` (built in the
// composition root from `spawn` + the standalone-client adapter), and emit the
// normalised RunUiEvent lifecycle the UI sink/view-model consume. All
// VS Code-, SDK-, and binary-path concerns are injected, never imported here.

// Fallback fan-out limit when the composition root doesn't inject `concurrency`.
// The running system sources the real value from core (DEFAULT_CONCURRENCY),
// passed in via createRuntimeBridge; this literal is only a last-resort default.
const DEFAULT_CONCURRENCY = 16;
const EXPLORE_PHASE = "explore";
const SYNTH_PHASE = "synth";

/** Minimal promise pool: run `tasks` with at most `limit` in flight, preserving order. */
async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

function outputText(result) {
  if (result?.output && typeof result.output === "object" && "text" in result.output) {
    return result.output.text;
  }
  return result?.output;
}

/**
 * @param {{
 *   emit: (event: import("../core/ports.mjs").RunUiEvent) => void,
 *   planTask: (input: {subcommand: string, args: string}) => Promise<{task: string, agents: Array<object>}>,
 *   runAgent: (spec: object, ctx: { onProgress?: (p: object) => void, signal?: AbortSignal }) => Promise<object>,
 *   synthesize?: (input: {task: string, results: Array<object>, signal?: AbortSignal}) => Promise<object|string>,
 *   listWorkflows?: () => Promise<string[]>,
 *   loadWorkflow?: (name: string, args: string) => Promise<{task: string, agents: Array<object>}>,
 *   concurrency?: number,
 *   now?: () => number,
 *   newRunId?: (subcommand: string) => string,
 *   log?: import("../core/ports.mjs").LogPort,
 * }} deps
 * @returns {import("../core/ports.mjs").RuntimePort}
 */
export function createRuntimeBridge(deps) {
  const {
    emit,
    planTask,
    runAgent,
    synthesize,
    listWorkflows,
    loadWorkflow,
    concurrency = DEFAULT_CONCURRENCY,
    now = () => Date.now(),
    newRunId = (sc) => `${sc}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    log,
  } = deps;

  /** @type {Map<string, { controller: AbortController, task: string, specs: Map<string, object> }>} */
  const runs = new Map();
  const specKey = (phase, agentId) => `${phase}:${agentId}`;

  /** Run one spec, emitting started → tool* → finished, and return its result. */
  async function runOne(sink, runId, phase, spec, signal) {
    sink({
      type: "agent.started",
      runId,
      phase,
      agentId: spec.id,
      payload: { prompt: spec.prompt, model: spec.model, startedAt: now() },
    });
    let tokens;
    const onProgress = (p) => {
      if (!p) return;
      if (typeof p.tokens === "number") tokens = p.tokens;
      if (p.state === "tool") {
        sink({
          type: "agent.tool",
          runId,
          phase,
          agentId: spec.id,
          payload: { tool: p.tool, status: "running" },
        });
      }
    };
    let result;
    try {
      result = await runAgent(spec, { onProgress, signal });
    } catch (err) {
      result = { id: spec.id, spec, status: "error", error: err?.message ?? String(err), startedAt: now(), finishedAt: now() };
    }
    sink({
      type: "agent.finished",
      runId,
      phase,
      agentId: spec.id,
      payload: {
        status: result.status,
        output: outputText(result),
        error: result.error,
        tokens: tokens ?? result.tokens,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      },
    });
    return result;
  }

  async function fanOut(input, ctx) {
    const sink = ctx?.uiSink?.onRunEvent ?? emit;
    const controller = new AbortController();
    if (ctx?.cancellation?.onCancel) ctx.cancellation.onCancel(() => controller.abort());
    const runId = newRunId(input.subcommand);

    // Resolve the plan (saved workflow or LLM decomposition).
    let plan;
    try {
      plan =
        input.subcommand === "run" && loadWorkflow
          ? await loadWorkflow(...splitName(input.args))
          : await planTask(input);
    } catch (err) {
      sink({ type: "run.started", runId, payload: { task: input.args || input.subcommand } });
      sink({ type: "run.finished", runId, payload: { status: "error", error: err?.message ?? String(err) } });
      await log?.error?.(`maestro: planning failed — ${err?.message ?? err}`);
      return { runId, status: "error" };
    }

    const task = plan.task ?? input.args ?? input.subcommand;
    const specs = (plan.agents ?? []).map((s, i) => ({ id: s.id ?? `agent-${i + 1}`, ...s }));
    const run = { controller, task, specs: new Map() };
    runs.set(runId, run);
    for (const s of specs) run.specs.set(specKey(EXPLORE_PHASE, s.id), s);

    sink({ type: "run.started", runId, payload: { task } });
    sink({ type: "phase.started", runId, phase: EXPLORE_PHASE });
    await log?.info?.(`maestro: ${runId} fanning out ${specs.length} agent(s).`);

    const results = await pooled(specs, concurrency, (spec) =>
      runOne(sink, runId, EXPLORE_PHASE, spec, controller.signal),
    );

    // User cancelled (via CancellationToken or stopRun): don't run extra work
    // and don't override the stopped status with complete/error.
    if (controller.signal.aborted) {
      sink({ type: "run.finished", runId, payload: { status: "stopped" } });
      await log?.info?.(`maestro: ${runId} cancelled before synth.`);
      return { runId, status: "stopped" };
    }

    // Optional synth phase.
    if (synthesize && results.length) {
      const synthSpec = { id: "synth", agent: "synth", prompt: "synthesize", model: specs[0]?.model };
      run.specs.set(specKey(SYNTH_PHASE, "synth"), synthSpec);
      sink({ type: "phase.started", runId, phase: SYNTH_PHASE });
      sink({ type: "agent.started", runId, phase: SYNTH_PHASE, agentId: "synth", payload: { startedAt: now() } });
      let synthOut;
      let synthStatus = "ok";
      try {
        synthOut = await synthesize({ task, results, signal: controller.signal });
      } catch (err) {
        synthStatus = "error";
        synthOut = { error: err?.message ?? String(err) };
      }
      sink({
        type: "agent.finished",
        runId,
        phase: SYNTH_PHASE,
        agentId: "synth",
        payload: {
          status: synthStatus,
          output: typeof synthOut === "string" ? synthOut : outputText({ output: synthOut }),
          error: synthStatus === "error" ? synthOut?.error : undefined,
          finishedAt: now(),
        },
      });
    }

    const failed = results.some((r) => r && r.status !== "ok");
    sink({ type: "run.finished", runId, payload: { status: failed ? "error" : "complete" } });
    return { runId, status: failed ? "error" : "complete" };
  }

  return {
    async runCommand(input, ctx) {
      if (input.subcommand === "workflows") {
        const names = listWorkflows ? await listWorkflows() : [];
        if (names.length) await log?.info?.(`maestro: workflows — ${names.join(", ")}`);
        else await log?.info?.("maestro: no saved workflows found.");
        return { workflows: names };
      }
      return fanOut(input, ctx);
    },

    async resumeRun(runId) {
      await log?.warn?.(`maestro: resume for ${runId} is not supported on the VS Code surface yet.`);
    },

    async stopRun(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.controller.abort();
      emit({ type: "run.finished", runId, payload: { status: "stopped" } });
      await log?.info?.(`maestro: ${runId} stopped.`);
    },

    async retryAgent({ runId, phase, agentId }) {
      const run = runs.get(runId);
      const spec = run?.specs.get(specKey(phase, agentId));
      if (!run || !spec) return;
      await runOne(emit, runId, phase, spec, run.controller.signal);
    },
  };
}

/** Split a saved-workflow invocation "name rest of args" into [name, args]. */
function splitName(args) {
  const trimmed = (args ?? "").trim();
  const sp = trimmed.indexOf(" ");
  if (sp === -1) return [trimmed, ""];
  return [trimmed.slice(0, sp), trimmed.slice(sp + 1).trim()];
}
