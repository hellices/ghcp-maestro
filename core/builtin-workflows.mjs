// Built-in workflows (hello / brainstorm / task).
//
// Extracted from extension.mjs so the workflow bodies stop bloating the
// composition root and — more importantly — become unit-testable: extension.mjs
// runs joinSession() at import time, so nothing that lives there can be imported
// under `node --test`. This module imports only pure runtime helpers plus a
// `getAdapter` collaborator, so the three workflows can be driven end-to-end with
// the in-process dummy adapter and a temp RunStore.
//
// Every phase goes through the shared `runPhase` helper (monitor + spawnAll +
// settle + flush), so the monitoring choreography lives in exactly one place.

import { DEFAULT_CONCURRENCY } from "./spawn.mjs";
import { join } from "node:path";
import { runPhase } from "./run-phase.mjs";
import { createRun } from "./run-store.mjs";
import { failRun, completeRun, writeRunTrace } from "./run-flow.mjs";
import { releaseRun } from "./run-registry.mjs";
import { TIMEOUT_AGENT_MS } from "./timeouts.mjs";
import { isTruthyEnv } from "./env-flags.mjs";
import { buildPlanPrompt, parseAndValidatePlan, sanitizeAgentName, planLayers, augmentPromptWithDeps } from "./plan.mjs";
import { parseFileRefs, loadFileRefs, buildFileRefsBlock } from "./task-inputs.mjs";
import {
  parseWriteFlags,
  WRITE_FLAG,
  ALLOW_DIRTY_FLAG,
  assertWritableRepo,
  validateDisjointScopes,
  createWorktrees,
  buildWritePrompt,
  integrateBranches,
  cleanupWorktrees,
  makeCheckRunner,
} from "./write-mode.mjs";
import { planApprovalGate, phaseApprovalGate } from "./plan-approval.mjs";
import { createBudgetTracker, envBudgetTokens, estimateRunSize, envLargeRunAgents } from "./budget.mjs";
import { envModelRoutes, resolveModel } from "./model-routes.mjs";
import { buildSynthPrompt, buildVerifyPrompt } from "./synth.mjs";
import {
  exploreResultLine,
  wallClockLine,
  allFailed,
  agentDigest,
  coverageLine,
  logExploreResults,
  labeledDumpLine,
  synthStatusLine,
} from "./workflow-log.mjs";

// Worktree dirs and branch names land on case-insensitive filesystems
// (Windows/macOS default), where "API" and "api" are the same directory —
// hence the lowercasing on top of the base sanitizer.
const sanitizeWriteAgentName = (name) => sanitizeAgentName(name).toLowerCase();

/**
 * Spread-helper: `{ model }` when the routing map resolved one, `{}` otherwise —
 * keeps unrouted specs byte-identical to the pre-#17 shape (agent-record cache
 * compatibility across resumes).
 *
 * @param {string | undefined} model
 */
function withModel(model) {
  return model !== undefined ? { model } : {};
}

/**
 * Compose the three built-in workflow handlers over an adapter provider.
 *
 * @param {{
 *   getAdapter: () => import("./spawn.mjs").SubagentAdapter,
 *   env?: Record<string, string | undefined>,
 * }} deps
 */
export function createBuiltinWorkflows(deps) {
  const getAdapter = deps.getAdapter;
  const env = deps.env ?? process.env;

  /** Log the "running in background — watch with /maestros" hint for fresh runs. */
  async function logBackgroundHint(session, runId, opts) {
    if (!opts.run) {
      await session.log(`ghcp-maestro/${runId}: running in background — watch with /maestros ${runId}`);
    }
  }

  // --- Hello workflow (diagnostic smoke test) -------------------------------

  /**
   * Two-phase diagnostic smoke test (ALPHA/BRAVO/CHARLIE → joined). Verifies the
   * fan-out pipeline end-to-end; hidden from /maestro help.
   */
  async function runHelloWorkflow(session, opts = {}) {
    const run = opts.run ?? (await createRun({ workflow: "hello" }));
    const runId = run.runId;
    const adapter = getAdapter();
    await session.log(
      `ghcp-maestro/${runId}: starting hello workflow (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
    );
    await logBackgroundHint(session, runId, opts);

    // Phase 1 — explore (fan-out)
    await session.log(`ghcp-maestro/${runId}: phase=explore agents=3 (parallel)`);
    const exploreSpecs = ["ALPHA", "BRAVO", "CHARLIE"].map((word, i) => ({
      id: `explore-${"abc"[i]}`,
      agent: `explore-${"abc"[i]}`,
      prompt: `Reply with the single word ${word}. No punctuation, no explanation.`,
      timeoutMs: TIMEOUT_AGENT_MS,
    }));
    const { results: exploreResults, elapsedMs: phase1Elapsed } = await runPhase(exploreSpecs, {
      run,
      runId,
      phase: "explore",
      adapter,
    });
    for (const r of exploreResults) {
      await session.log(exploreResultLine(runId, r, { mode: "reply" }));
    }
    await session.log(wallClockLine(runId, phase1Elapsed, 3));

    // Phase 2 — synth (uses outputs from phase 1)
    await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
    const collected = exploreResults
      .map((r) => `- ${r.spec.agent}: ${(r.output?.text ?? "").trim()}`)
      .join("\n");
    const synthSpec = {
      id: "synth",
      agent: "synth",
      prompt: `Three explore agents replied below. Join their replies with a single space, in the order they appear, and reply with only that joined string — no punctuation, no explanation.\n\n${collected}`,
      timeoutMs: TIMEOUT_AGENT_MS,
    };
    const {
      results: [synth],
      elapsedMs: phase2Elapsed,
    } = await runPhase([synthSpec], { run, runId, phase: "synth", adapter });
    const synthText = (synth.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: synth status=${synth.status}${synth.cached ? " (cached)" : ""} took=${synth.finishedAt - synth.startedAt}ms wall=${phase2Elapsed}ms reply=${JSON.stringify(synthText.slice(0, 80))}`,
    );

    await completeRun(run);
    await session.log(
      `ghcp-maestro/${runId}: hello workflow complete (${exploreResults.length + 1} agents across 2 phases)`,
    );
    return run;
  }

  // --- Brainstorm workflow --------------------------------------------------

  /**
   * Multi-angle brainstorm: 4 lenses (tech/ux/biz/risk) in parallel, then a
   * synth agent derives the strongest 3 next steps.
   */
  async function runBrainstormWorkflow(session, rawTopic, opts = {}) {
    // @file references (#39): same contract as the task workflow — resolve
    // before the run exists, abort on unreadable files, keep the raw line in
    // the manifest for resume.
    const inputs = await resolveTaskInputs(session, rawTopic, opts);
    if (!inputs) return null;
    const { task: topic, refsBlock } = inputs;
    const run = opts.run ?? (await createRun({ workflow: "brainstorm", args: { topic: rawTopic } }));
    const runId = run.runId;
    const adapter = getAdapter();
    await session.log(
      `ghcp-maestro/${runId}: brainstorm "${topic.slice(0, 80)}" (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
    );
    await logBackgroundHint(session, runId, opts);

    const angles = [
      {
        agent: "tech",
        lens: "Technical / implementation",
        ask: "What are the most important technical considerations, architectural choices, and likely failure modes?",
      },
      {
        agent: "ux",
        lens: "User experience",
        ask: "Who are the users, what jobs are they hiring this to do, and what would make or break their daily experience?",
      },
      {
        agent: "biz",
        lens: "Business / strategy",
        ask: "What is the value proposition, how does it compare to alternatives, and what would need to be true for it to be worth doing?",
      },
      {
        agent: "risk",
        lens: "Risks and unknowns",
        ask: "What could go wrong, what assumptions are most fragile, and which questions must be answered before committing?",
      },
    ];

    await session.log(`ghcp-maestro/${runId}: phase=explore agents=${angles.length} (parallel)`);
    const specs = angles.map((a) => ({
      id: `explore-${a.agent}`,
      agent: a.agent,
      prompt: [
        `You are a focused brainstorming agent. Lens: ${a.lens}.`,
        "",
        `Topic: ${topic}`,
        "",
        `Question: ${a.ask}`,
        "",
        "Reply with 3-5 short bullet points. Be concrete and specific to this topic. No preamble, no 'as an AI', just the bullets.",
      ].join("\n") + refsBlock,
      timeoutMs: TIMEOUT_AGENT_MS,
    }));

    const { results, elapsedMs: phase1Elapsed } = await runPhase(specs, {
      run,
      runId,
      phase: "explore",
      adapter,
    });

    await logExploreResults({
      runId,
      results,
      elapsedMs: phase1Elapsed,
      count: angles.length,
      label: "explore",
      log: (msg, o) => session.log(msg, o),
    });
    if (allFailed(results)) {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: brainstorm aborted — all ${results.length} explore agents failed`,
      );
    }

    // Phase 2 — synth
    await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
    const digest = agentDigest(results);
    const synthPrompt = [
      `You are a synthesis agent. Four independent agents brainstormed the topic from different lenses. Pick the strongest 3 actionable next steps that survive cross-checking across lenses.`,
      "",
      `Topic: ${topic}`,
      "",
      `Lens outputs:`,
      digest,
      "",
      `Reply with exactly 3 lines, each formatted as "<short title> — <one-sentence rationale citing which lenses agreed>". No preamble.`,
    ].join("\n");

    const synthSpec = { id: "synth", agent: "synth", prompt: synthPrompt, timeoutMs: TIMEOUT_AGENT_MS };
    const {
      results: [synth],
      elapsedMs: phase2Elapsed,
    } = await runPhase([synthSpec], { run, runId, phase: "synth", adapter });
    await session.log(synthStatusLine(runId, synth));
    await session.log(labeledDumpLine(runId, "TOP 3 NEXT STEPS", synth));

    if (synth.status !== "ok") {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: brainstorm failed — synth ${synth.status}: ${synth.error ?? "(no error)"}`,
      );
    }

    await completeRun(run);
    await session.log(
      `ghcp-maestro/${runId}: brainstorm complete — ${results.length + 1} agents across 2 phases (phase1=${phase1Elapsed}ms parallel, phase2=${phase2Elapsed}ms)`,
    );
    return run;
  }

  // --- Task workflow (M4 — LLM-driven task decomposition) -------------------

  /**
   * Resolve `@file` references (#39) out of a raw task/topic line.
   *
   * Returns `{ task, refsBlock }` — with the raw line untouched when there are
   * no references (byte-identical prompts to pre-#39 runs) — or `null` after
   * logging when any referenced file cannot be read, so callers abort before a
   * run is created or a single token is spent.
   */
  async function resolveTaskInputs(session, raw, opts = {}) {
    const { refs, task } = parseFileRefs(raw);
    if (refs.length === 0) return { task: raw, refsBlock: "" };
    let files;
    try {
      files = await loadFileRefs(refs, {
        cwd: opts.cwd,
        readFile: opts.readFile,
        stat: opts.stat,
      });
    } catch (err) {
      // On resume a RunHandle already exists and its manifest was just set to
      // "running" — propagate so resumeRun's failRun marks it failed instead
      // of leaving the run stuck. Fresh runs simply abort before creation.
      if (opts.run) throw err;
      await session.log(`ghcp-maestro: ${err?.message ?? err} — aborting before fan-out`, {
        level: "error",
      });
      return null;
    }
    const totalChars = files.reduce((n, f) => n + f.content.length, 0);
    const truncated = files.filter((f) => f.truncated).map((f) => f.path);
    await session.log(
      `ghcp-maestro: inlined ${files.length} @file reference(s) (${totalChars} chars${truncated.length > 0 ? `; truncated: ${truncated.join(", ")}` : ""}): ${files.map((f) => f.path).join(", ")}`,
    );
    return {
      task: task || "Carry out the request described in the referenced file(s).",
      refsBlock: buildFileRefsBlock(files),
    };
  }

  /**
   * Generic dynamic workflow: an LLM decomposes an arbitrary task into
   * independent subtasks (plan), fans them out (explore), then merges the
   * outputs into a final answer (synth). All phases share a RunHandle so any
   * subagent that already succeeded is replayed from cache on /maestro-resume.
   */
  async function runTaskWorkflow(session, rawTask, opts = {}) {
    // Write mode (#40): strictly opt-in — via --write on the task line or the
    // opts.write escape hatch (used by other surfaces/tests). The manifest
    // task line carries the EFFECTIVE flags (see manifestTask below), so
    // resume replays the same mode even when it was enabled via opts.write.
    const flags = parseWriteFlags(rawTask);
    const writeMode = flags.write || opts.write === true;
    const gitExec = opts.gitExec; // injectable for tests; undefined = real git
    let targetBranch;
    if (writeMode) {
      try {
        ({ branch: targetBranch } = await assertWritableRepo({
          exec: gitExec,
          cwd: opts.cwd,
          allowDirty: flags.allowDirty || opts.allowDirty === true,
        }));
      } catch (err) {
        if (opts.run) throw err;
        await session.log(`ghcp-maestro: ${err?.message ?? err}`, { level: "error" });
        return null;
      }
    }
    // @file references (#39): resolve before the run exists so a bad path
    // costs nothing. The manifest keeps the RAW line — resume replays the
    // same resolution (and correctly fails if the spec file disappeared).
    // Flag stripping only applies in write mode — a read-only task keeps its
    // text verbatim (e.g. a question ABOUT "--allow-dirty").
    const inputs = await resolveTaskInputs(session, writeMode ? flags.task : rawTask, opts);
    if (!inputs) return null;
    const { task, refsBlock } = inputs;
    // The manifest line must carry the EFFECTIVE flags — write mode enabled
    // via opts.write alone would otherwise be silently off on /maestro-resume
    // (resume replays only the manifest's raw line).
    const manifestTask = writeMode
      ? [
          WRITE_FLAG,
          flags.allowDirty || opts.allowDirty === true ? ALLOW_DIRTY_FLAG : null,
          flags.task,
        ]
          .filter(Boolean)
          .join(" ")
      : rawTask;
    const run = opts.run ?? (await createRun({ workflow: "task", args: { task: manifestTask } }));
    const runId = run.runId;
    const adapter = getAdapter();
    // Per-run token budget (#14): accumulates per-turn usage across ALL phases;
    // when exceeded, un-started agents are skipped and the run soft-stops.
    const budget = createBudgetTracker(opts.budgetTokens ?? envBudgetTokens(env));
    // Accounting stays cumulative across resumes: prior attempts' spend is kept
    // separate from the tracker so enforcement still runs under a fresh budget
    // (the resume contract), but the persisted tokensUsed never shrinks.
    const priorTokens =
      typeof run.manifest?.tokensUsed === "number" && run.manifest.tokensUsed > 0
        ? run.manifest.tokensUsed
        : 0;
    const totalTokens = () => priorTokens + budget.used();
    // Terminal manifest patch for accounting — every terminal path (complete,
    // stopped, error) persists the cumulative spend when there is any.
    const tokensPatch = () => (totalTokens() > 0 ? { tokensUsed: totalTokens() } : {});
    // Model routing (#17): opt-in per-label model map ("plan" / "explore:<agent>"
    // / "synth"). Null routes = every agent uses the adapter's default model.
    const routes = opts.modelRoutes ?? envModelRoutes(env);
    await session.log(
      `ghcp-maestro/${runId}: task "${task.slice(0, 80)}" (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
    );
    if (writeMode) {
      await session.log(
        `ghcp-maestro/${runId}: WRITE MODE — worktree-per-agent isolation, integrating into branch "${targetBranch}"`,
      );
    }
    if (budget.limit) {
      await session.log(`ghcp-maestro/${runId}: token budget: ${budget.limit} tokens`);
    }
    if (routes) {
      await session.log(`ghcp-maestro/${runId}: model routes: ${JSON.stringify(routes)}`);
    }
    await logBackgroundHint(session, runId, opts);

    // Phase 1 — plan: ask the LLM to decompose the task.
    await session.log(`ghcp-maestro/${runId}: phase=plan agents=1`);
    const planSpec = {
      id: "plan",
      agent: "plan",
      timeoutMs: TIMEOUT_AGENT_MS,
      prompt: buildPlanPrompt(task, undefined, undefined, refsBlock, writeMode),
      ...withModel(resolveModel("plan", routes)),
    };
    const {
      results: [planResult],
    } = await runPhase([planSpec], { run, runId, phase: "plan", adapter, budget });
    if (planResult.status !== "ok") {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: plan agent ${planResult.status}: ${planResult.error ?? "(no error)"}`,
        tokensPatch(),
      );
    }
    const planText = (planResult.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: plan${planResult.cached ? " (cached)" : ""} took=${planResult.finishedAt - planResult.startedAt}ms chars=${planText.length}`,
    );

    // Write mode adds a second validation layer on top of the schema: scopes
    // must be disjoint (the same-file-overwrite hazard) and agent ids must
    // stay unique AFTER sanitization (branch/worktree names derive from the
    // sanitized id — a collision would silently share a worktree). Both throw
    // a human-readable message the planner can retry against.
    const validatePlanText = (text) => {
      const parsed = parseAndValidatePlan(text, { requireFiles: writeMode });
      if (writeMode) {
        // validateDisjointScopes returns the NORMALIZED scopes — use those
        // everywhere downstream (worktree prompts) so raw model output can't
        // smuggle control characters or path variants past validation.
        const normalizedScopes = validateDisjointScopes(parsed);
        for (let i = 0; i < parsed.length; i += 1) {
          parsed[i] = { ...parsed[i], files: normalizedScopes[i].files };
        }
        const sanitized = new Map();
        for (const s of parsed) {
          // Lowercased key: worktree dirs land on case-insensitive
          // filesystems (Windows/macOS default), where "API" and "api" are
          // the same directory.
          const key = sanitizeWriteAgentName(s.agent);
          if (sanitized.has(key)) {
            throw new Error(
              `write mode: agent ids "${sanitized.get(key)}" and "${s.agent}" collide after sanitization ("${key}") — branch and worktree names must be unique; rename one`,
            );
          }
          sanitized.set(key, s.agent);
        }
      }
      return parsed;
    };

    let specs;
    try {
      specs = validatePlanText(planText);
    } catch (err) {
      await session.log(
        `ghcp-maestro/${runId}: plan parse failed: ${err.message}. Asking the planner to retry with the parser feedback.`,
        { level: "warning" },
      );
      // One retry with the parser feedback included. Force a new agentId so we
      // don't hit the cached bad plan.
      const retrySpec = {
        id: "plan-retry",
        agent: "plan",
        timeoutMs: TIMEOUT_AGENT_MS,
        prompt: buildPlanPrompt(task, err.message, planText, refsBlock, writeMode),
        ...withModel(resolveModel("plan", routes)),
      };
      const {
        results: [retryResult],
      } = await runPhase([retrySpec], { run, runId, phase: "plan", adapter, budget });
      if (retryResult.status !== "ok") {
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: plan retry ${retryResult.status}: ${retryResult.error ?? "(no error)"}`,
          tokensPatch(),
        );
      }
      try {
        specs = validatePlanText((retryResult.output?.text ?? "").trim());
      } catch (err2) {
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: plan retry also unparseable: ${err2.message}`,
          tokensPatch(),
        );
      }
    }

    await session.log(
      `ghcp-maestro/${runId}: plan produced ${specs.length} subtask(s): ${specs.map((s) => s.agent).join(", ")}`,
    );

    // Cost visibility at the gate (#14): a coarse run-size signal (subtasks +
    // plan + synth) and an advisory warning for large fan-outs.
    const totalAgents = specs.length + 2;
    const estimate = `est. run size: ${estimateRunSize(totalAgents)} (${totalAgents} agents incl. plan+synth)`;
    await session.log(`ghcp-maestro/${runId}: ${estimate}`);
    if (specs.length >= envLargeRunAgents(env)) {
      await session.log(
        `ghcp-maestro/${runId}: large fan-out: ${specs.length} subtask(s) — each runs its own child session; consider narrowing the selection at the gate`,
        { level: "warning" },
      );
    }

    // M4.x — pre-approval gate. On an interactive host, let the user review the
    // subtasks and approve (or drop a subset / abort) before the expensive
    // fan-out. Non-interactive hosts, resume replays, and an explicit
    // GHCP_MAESTRO_AUTO_APPROVE bypass approve everything automatically.
    const autoApprove =
      opts.autoApprove === true ||
      isTruthyEnv(env.GHCP_MAESTRO_AUTO_APPROVE) ||
      Boolean(opts.run);
    const gateUi = session.capabilities?.ui?.elicitation ? session.ui : null;
    const gate = await planApprovalGate({
      specs,
      ui: gateUi,
      capabilities: session.capabilities,
      autoApprove,
      estimate,
      log: (msg, options) => session.log(`ghcp-maestro/${runId}: ${msg}`, options),
    });
    if (!gate.approved) {
      // Release first: releaseRun never throws, so the controller can't leak
      // even if persisting the "stopped" status fails. The plan agent already
      // spent tokens, so the stopped manifest still gets accounting + a trace.
      releaseRun(runId);
      await run.patchManifest({
        status: "stopped",
        finishedAt: Date.now(),
        ...tokensPatch(),
      });
      await writeRunTrace(run);
      await session.log(
        `ghcp-maestro/${runId}: task ${gate.reason === "empty-selection" ? "aborted (no subtasks selected)" : `cancelled by user (${gate.reason})`} — fan-out skipped`,
        { level: "warning" },
      );
      return run;
    }
    if (gate.selected.length !== specs.length) {
      await session.log(
        `ghcp-maestro/${runId}: user approved ${gate.selected.length}/${specs.length} subtask(s): ${gate.selected.map((s) => s.agent).join(", ")}`,
      );
      specs = gate.selected;
    }

    // Write mode (#40): one worktree + branch per agent, created only after
    // the gate so an aborted run never litters the repo. Failure here is
    // fatal — a partial worktree set must not fan out.
    let worktrees = [];
    const worktreeByAgent = new Map();
    if (writeMode) {
      const worktreeRoot = join(run.runDir, "worktrees");
      try {
        worktrees = await createWorktrees(specs.map((s) => ({ agent: sanitizeWriteAgentName(s.agent) })), {
          exec: gitExec,
          cwd: opts.cwd,
          root: worktreeRoot,
          runId,
        });
      } catch (err) {
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: write mode: worktree setup failed: ${err?.message ?? err}`,
          tokensPatch(),
        );
      }
      for (const [i, wt] of worktrees.entries()) {
        worktreeByAgent.set(specs[i].agent, { ...wt, files: specs[i].files ?? [] });
      }
      // Cap the enumeration — at large fan-outs a full branch list would blow
      // up the JSON-RPC log payload. Names follow maestro/<runId>/<agent>
      // anyway, so the head + count is enough to locate them.
      const branchPreview = worktrees
        .slice(0, 8)
        .map((w) => w.branch)
        .join(", ");
      const branchSuffix = worktrees.length > 8 ? `, … +${worktrees.length - 8} more` : "";
      await session.log(
        `ghcp-maestro/${runId}: created ${worktrees.length} worktree(s) under ${worktreeRoot} (branches: ${branchPreview}${branchSuffix})`,
      );
    }

    // Phase 2 — explore: fan out the planned specs, layer by layer (#21).
    // Independent specs land in layer 0 and run in one parallel wave exactly as
    // before; specs with `dependsOn` run in later layers with their
    // dependencies' outputs appended to the prompt. A dependent whose
    // dependency did not finish `ok` is recorded as `skipped` without ever
    // invoking the adapter (the record persists, so /maestro-resume reruns it).
    const exploreSpecs = specs.map((s, i) => ({
      id: `explore-${i}-${sanitizeAgentName(s.agent)}`,
      agent: s.agent,
      // Subtask prompts carry the spec too (#39): each child session is
      // isolated, so without this it would have to rediscover the file — or
      // worse, run blind against a one-line summary of a detailed spec.
      // Write mode (#40) additionally pins the agent to its own worktree.
      prompt:
        (worktreeByAgent.has(s.agent)
          ? buildWritePrompt(s.prompt, worktreeByAgent.get(s.agent))
          : s.prompt) + refsBlock,
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      timeoutMs: TIMEOUT_AGENT_MS,
      ...withModel(resolveModel(`explore:${s.agent}`, routes)),
    }));
    // The gate may have deselected a dependency. Layer on deps filtered to the
    // selected set so planLayers can't throw "unknown dependency"; the skip
    // check below still consults the ORIGINAL dependsOn, so a dependent of a
    // deselected subtask is skipped (its dep never lands in resultByAgent).
    const selectedNames = new Set(exploreSpecs.map((s) => s.agent));
    const layers = planLayers(
      exploreSpecs.map((s) =>
        s.dependsOn ? { ...s, dependsOn: s.dependsOn.filter((d) => selectedNames.has(d)) } : s,
      ),
    );
    const specByAgent = new Map(exploreSpecs.map((s) => [s.agent, s]));
    await session.log(
      `ghcp-maestro/${runId}: phase=explore agents=${specs.length}${layers.length > 1 ? ` layers=${layers.length} (topological)` : " (parallel)"}`,
    );
    const resultByAgent = new Map();
    let phase1Elapsed = 0;
    for (const layer of layers) {
      const runnable = [];
      for (const layerSpec of layer) {
        const spec = specByAgent.get(layerSpec.agent);
        const failedDep = (spec.dependsOn ?? []).find(
          (d) => resultByAgent.get(d)?.status !== "ok",
        );
        if (failedDep !== undefined) {
          const now = Date.now();
          const skipped = {
            id: spec.id,
            spec,
            status: "skipped",
            error: `dependency "${failedDep}" did not complete — subtask skipped`,
            startedAt: now,
            finishedAt: now,
            attempts: 0,
          };
          await run.writeAgent({ agentId: spec.id, ...skipped });
          resultByAgent.set(spec.agent, skipped);
          await session.log(
            `ghcp-maestro/${runId}: explore/${spec.agent} skipped — dependency "${failedDep}" did not complete`,
            { level: "warning" },
          );
          continue;
        }
        const deps = (spec.dependsOn ?? []).map((d) => ({
          agent: d,
          text: resultByAgent.get(d)?.output?.text ?? "",
        }));
        runnable.push(
          deps.length > 0 ? { ...spec, prompt: augmentPromptWithDeps(spec.prompt, deps) } : spec,
        );
      }
      if (runnable.length === 0) continue;
      const { results, elapsedMs } = await runPhase(runnable, {
        run,
        runId,
        phase: "explore",
        adapter,
        budget,
      });
      phase1Elapsed += elapsedMs;
      for (const r of results) resultByAgent.set(r.spec.agent, r);
    }
    const exploreResults = exploreSpecs.map((s) => resultByAgent.get(s.agent));
    await logExploreResults({
      runId,
      results: exploreResults,
      elapsedMs: phase1Elapsed,
      count: specs.length,
      label: "subtask",
      log: (msg, o) => session.log(msg, o),
    });
    if (allFailed(exploreResults)) {
      const timedOut = exploreResults.some((r) => r.status === "timeout");
      const hint = timedOut
        ? ` (agents hit the ${TIMEOUT_AGENT_MS}ms timeout — raise it with GHCP_MAESTRO_TIMEOUT_MS for longer research runs)`
        : "";
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: task aborted — all ${exploreResults.length} subtask agents failed${hint}`,
        tokensPatch(),
      );
    }

    // Mid-run steering (#15): opt-in pause after the fan-out, before the next
    // spend (write-mode integration / verify / synth). Placed before
    // integration deliberately — in write mode the user can inspect agent
    // outputs and stop BEFORE anything is merged. Declining stops the run
    // (resumable: cached ok agents replay, and resume auto-approves the gate).
    const phaseGateEnabled = opts.phaseGate === true || isTruthyEnv(env.GHCP_MAESTRO_PHASE_GATE);
    // With the budget already blown, verify/synth won't run regardless of the
    // answer — asking "continue?" and then soft-stopping anyway would mislead.
    // Skip the dialog and let the budget stop speak. Write mode still gates:
    // integration is a real next step that runs even over budget.
    const gateMootOverBudget = budget.exceeded() && !writeMode;
    if (phaseGateEnabled && gateMootOverBudget) {
      await session.log(
        `ghcp-maestro/${runId}: phase gate skipped — token budget already exceeded, the run will soft-stop`,
      );
    }
    if (phaseGateEnabled && !gateMootOverBudget) {
      const nextPhase = writeMode
        ? "integrate"
        : opts.verify === true || isTruthyEnv(env.GHCP_MAESTRO_VERIFY)
          ? "verify"
          : "synth";
      const midGate = await phaseApprovalGate({
        phase: "explore",
        next: nextPhase,
        results: exploreResults.map((r) => ({
          agent: r.spec.agent,
          status: r.status,
          preview: r.status === "ok" ? (r.output?.text ?? "") : (r.error ?? ""),
        })),
        ui: gateUi,
        capabilities: session.capabilities,
        autoApprove,
        log: (msg, options) => session.log(`ghcp-maestro/${runId}: ${msg}`, options),
      });
      if (!midGate.approved) {
        releaseRun(runId);
        await run.patchManifest({
          status: "stopped",
          finishedAt: Date.now(),
          ...tokensPatch(),
        });
        await writeRunTrace(run);
        await session.log(
          `ghcp-maestro/${runId}: phase gate: stopped after explore (${midGate.reason})${writeMode ? " — nothing was merged; agent branches and worktrees are kept" : ""} — inspect the outputs above and finish later with /maestro-resume ${runId}`,
          { level: "warning" },
        );
        return run;
      }
    }

    // Write mode (#40): sequential integration — merge each ok agent's branch
    // back into the target branch one at a time, running the optional check
    // command after each merge (the only documented mitigation for semantic
    // conflicts git can't detect). A conflict or check failure stops
    // integration with the remaining branches left for manual resolution.
    if (writeMode) {
      // Merge in topological order — dependencies land on the target branch
      // before their dependents, mirroring the explore layers. On resume,
      // branches the previous attempt already merged (recorded in the
      // manifest) are skipped — re-merging is a no-op but would re-run the
      // check command, which may be slow or carry side effects.
      const alreadyMerged = new Set(run.manifest?.write?.merged ?? []);
      const okAgents = layers
        .flat()
        .map((s) => s.agent)
        .filter((agent) => resultByAgent.get(agent)?.status === "ok")
        .map((agent) => ({ agent, branch: worktreeByAgent.get(agent).branch }));
      const okBranches = okAgents.filter(({ branch }) => !alreadyMerged.has(branch));
      const checkCmd = opts.checkCmd ?? (env.GHCP_MAESTRO_CHECK_CMD || undefined);
      const runCheck =
        opts.runCheck ?? (checkCmd ? makeCheckRunner(checkCmd, opts.cwd) : undefined);
      await session.log(
        `ghcp-maestro/${runId}: phase=integrate branches=${okBranches.length}${alreadyMerged.size > 0 ? ` (skipping ${alreadyMerged.size} already merged)` : ""} target=${targetBranch}${checkCmd ? ` check="${checkCmd}"` : ""}`,
      );
      let integration;
      try {
        integration = await integrateBranches(okBranches, {
          exec: gitExec,
          cwd: opts.cwd,
          targetBranch,
          runCheck,
          log: (msg) => session.log(`ghcp-maestro/${runId}: ${msg}`),
        });
      } catch (err) {
        // e.g. HEAD moved off targetBranch while agents ran. Fail the run
        // explicitly — bubbling would leave it stuck in "running" with the
        // worktrees leaked silently.
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: write mode: integration failed — ${err?.message ?? err}. Nothing was merged; agent branches and worktrees are kept under ${join(run.runDir, "worktrees")}. Fix the repo state and run /maestro-resume ${runId}`,
          tokensPatch(),
        );
      }
      // Remove the worktrees whose branches are on the target branch: newly
      // merged ones, plus already-merged ones recreated by resume (their
      // content landed in a previous attempt). Failed and remaining ones keep
      // their worktrees so nothing is lost.
      const mergedAgents = new Set(
        okAgents
          .filter((b) => integration.merged.includes(b.branch) || alreadyMerged.has(b.branch))
          .map((b) => b.agent),
      );
      const cleanup = await cleanupWorktrees(
        specs
          .filter((s) => mergedAgents.has(s.agent))
          .map((s) => ({
            agent: s.agent,
            dir: worktreeByAgent.get(s.agent).dir,
            branch: worktreeByAgent.get(s.agent).branch,
          })),
        { exec: gitExec, cwd: opts.cwd },
      );
      for (const keptWt of cleanup.kept) {
        await session.log(`ghcp-maestro/${runId}: kept worktree ${keptWt.dir} (${keptWt.reason})`, {
          level: "warning",
        });
      }
      await run.patchManifest({
        write: {
          targetBranch,
          // Cumulative across resume attempts — the filter above relies on
          // it. A check-failure merge stays APPLIED on the target branch, so
          // it counts as merged too: resume must not re-merge it or re-run
          // the check for it (reverting it is a deliberate manual act — after
          // that, integrate the branch manually as well).
          merged: [
            ...alreadyMerged,
            ...integration.merged,
            ...(integration.failed?.applied ? [integration.failed.branch] : []),
          ],
          failed: integration.failed,
          remaining: integration.remaining,
        },
      });
      if (integration.failed) {
        // A check failure leaves the merge applied on the target branch (so
        // the failing state is inspectable); a failed merge is rolled back,
        // leaving the branch fully unmerged. Word the report accordingly —
        // the detailed reason above carries git's own output.
        const failedNote = integration.failed.applied
          ? `The failing merge of ${integration.failed.branch} is still applied on ${targetBranch} — inspect or revert it (resume will NOT re-merge or re-check it).`
          : `${integration.failed.branch} was not merged (the merge was rolled back) — resolve manually.`;
        const remainingNote =
          integration.remaining.length > 0
            ? ` Remaining unmerged: ${integration.remaining.join(", ")}.`
            : "";
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: write mode: integration stopped at "${integration.failed.agent}" — ${integration.failed.reason}. Merged: ${integration.merged.length > 0 ? integration.merged.join(", ") : "(none)"}. ${failedNote}${remainingNote} (worktrees kept under ${join(run.runDir, "worktrees")})`,
          tokensPatch(),
        );
      }
      await session.log(
        `ghcp-maestro/${runId}: integration complete — ${integration.merged.length} branch(es) merged into ${targetBranch}; worktrees removed: ${cleanup.removed.length}`,
      );
    }

    // Budget soft-stop (#14): don't schedule the next agent once the cap is
    // blown. The run stays resumable — /maestro-resume replays the cached ok
    // subtasks and reruns only the skipped/failed ones under a fresh budget.
    const budgetStop = async (before) => {
      releaseRun(runId);
      await run.patchManifest({
        status: "stopped",
        finishedAt: Date.now(),
        tokensUsed: totalTokens(),
      });
      await writeRunTrace(run);
      await session.log(
        `ghcp-maestro/${runId}: token budget exceeded (${budget.used()}/${budget.limit} tokens) — run stopped before ${before}; finish it later with /maestro-resume ${runId}`,
        { level: "warning" },
      );
      return run;
    };

    // Optional verify phase (#31): one agent judges each subtask output against
    // the original objective before synth (MAST: high-level objective
    // verification). Opt-in only — an extra agent is extra spend, same
    // principle as the budget: visibility always-on, cost opt-in. A verify
    // failure is non-fatal: warn and synthesize without the report.
    const verifyEnabled = opts.verify === true || isTruthyEnv(env.GHCP_MAESTRO_VERIFY);
    if (budget.exceeded()) return budgetStop(verifyEnabled ? "verify" : "synth");
    let verifyReport;
    if (verifyEnabled) {
      await session.log(`ghcp-maestro/${runId}: phase=verify agents=1`);
      const verifySpec = {
        id: "verify",
        agent: "verify",
        timeoutMs: TIMEOUT_AGENT_MS,
        prompt: buildVerifyPrompt({ task, results: exploreResults }),
        ...withModel(resolveModel("verify", routes)),
      };
      const {
        results: [verify],
      } = await runPhase([verifySpec], { run, runId, phase: "verify", adapter, budget });
      if (verify.status === "ok") {
        verifyReport = (verify.output?.text ?? "").trim() || undefined;
        await session.log(labeledDumpLine(runId, "VERIFY REPORT", verify));
      } else {
        await session.log(
          `ghcp-maestro/${runId}: verify agent ${verify.status}: ${verify.error ?? "(no error)"} — continuing to synth without a verification report`,
          { level: "warning" },
        );
      }
      // The verify agent itself consumes tokens — re-check so a cap blown by
      // verify soft-stops the run instead of failing it when synth is skipped.
      if (budget.exceeded()) return budgetStop("synth");
    }

    // Phase 3 — synth: merge into a single answer to the original task.
    await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
    const synthSpec = {
      id: "synth",
      agent: "synth",
      timeoutMs: TIMEOUT_AGENT_MS,
      prompt: buildSynthPrompt({ task, results: exploreResults, verifyReport }),
      ...withModel(resolveModel("synth", routes)),
    };
    const {
      results: [synth],
      elapsedMs: phase2Elapsed,
    } = await runPhase([synthSpec], { run, runId, phase: "synth", adapter, budget });
    await session.log(synthStatusLine(runId, synth, { wallMs: phase2Elapsed }));
    await session.log(coverageLine(runId, exploreResults));
    await session.log(labeledDumpLine(runId, "FINAL ANSWER", synth));

    if (synth.status !== "ok") {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: task failed — synth ${synth.status}: ${synth.error ?? "(no error)"}`,
        tokensPatch(),
      );
    }

    // Token accounting is always-on (independent of any cap): persist the
    // aggregate so /maestros can show per-run cost even without a budget set.
    // Cumulative across resumes — prior attempts' spend is never clobbered.
    if (totalTokens() > 0) await run.patchManifest({ tokensUsed: totalTokens() });
    await completeRun(run);
    // The `/limit` suffix only makes sense when the whole figure ran under the
    // current attempt's cap — on resumes the total is cumulative across
    // attempts while the cap is per-attempt, so the suffix would mislead.
    const limitNote = budget.limit && priorTokens === 0 ? `/${budget.limit}` : "";
    const tokensNote = totalTokens() > 0 ? ` tokens=${totalTokens()}${limitNote}` : "";
    // Count the verify phase whenever it was enabled — the agent ran (and
    // spent) even if it failed or produced an empty report.
    const verifyRan = verifyEnabled ? 1 : 0;
    await session.log(
      `ghcp-maestro/${runId}: task workflow complete — ${1 + exploreResults.length + verifyRan + 1} agents across ${3 + verifyRan} phases (plan + explore[${specs.length}]${verifyRan ? " + verify" : ""} + synth)${tokensNote}`,
    );
    return run;
  }

  return { runHelloWorkflow, runBrainstormWorkflow, runTaskWorkflow };
}
