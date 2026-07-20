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
import { runPhase } from "./run-phase.mjs";
import { createRun } from "./run-store.mjs";
import { failRun, completeRun } from "./run-flow.mjs";
import { releaseRun } from "./run-registry.mjs";
import { TIMEOUT_AGENT_MS } from "./timeouts.mjs";
import { isTruthyEnv } from "./env-flags.mjs";
import { buildPlanPrompt, parseAndValidatePlan, sanitizeAgentName } from "./plan.mjs";
import { planApprovalGate } from "./plan-approval.mjs";
import { buildSynthPrompt } from "./synth.mjs";
import {
  exploreResultLine,
  wallClockLine,
  allFailed,
  agentDigest,
  logExploreResults,
  labeledDumpLine,
  synthStatusLine,
} from "./workflow-log.mjs";

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
  async function runBrainstormWorkflow(session, topic, opts = {}) {
    const run = opts.run ?? (await createRun({ workflow: "brainstorm", args: { topic } }));
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
      ].join("\n"),
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
   * Generic dynamic workflow: an LLM decomposes an arbitrary task into
   * independent subtasks (plan), fans them out (explore), then merges the
   * outputs into a final answer (synth). All phases share a RunHandle so any
   * subagent that already succeeded is replayed from cache on /maestro-resume.
   */
  async function runTaskWorkflow(session, task, opts = {}) {
    const run = opts.run ?? (await createRun({ workflow: "task", args: { task } }));
    const runId = run.runId;
    const adapter = getAdapter();
    await session.log(
      `ghcp-maestro/${runId}: task "${task.slice(0, 80)}" (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
    );
    await logBackgroundHint(session, runId, opts);

    // Phase 1 — plan: ask the LLM to decompose the task.
    await session.log(`ghcp-maestro/${runId}: phase=plan agents=1`);
    const planSpec = {
      id: "plan",
      agent: "plan",
      timeoutMs: TIMEOUT_AGENT_MS,
      prompt: buildPlanPrompt(task),
    };
    const {
      results: [planResult],
    } = await runPhase([planSpec], { run, runId, phase: "plan", adapter });
    if (planResult.status !== "ok") {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: plan agent ${planResult.status}: ${planResult.error ?? "(no error)"}`,
      );
    }
    const planText = (planResult.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: plan${planResult.cached ? " (cached)" : ""} took=${planResult.finishedAt - planResult.startedAt}ms chars=${planText.length}`,
    );

    let specs;
    try {
      specs = parseAndValidatePlan(planText);
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
        prompt: buildPlanPrompt(task, err.message, planText),
      };
      const {
        results: [retryResult],
      } = await runPhase([retrySpec], { run, runId, phase: "plan", adapter });
      if (retryResult.status !== "ok") {
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: plan retry ${retryResult.status}: ${retryResult.error ?? "(no error)"}`,
        );
      }
      try {
        specs = parseAndValidatePlan((retryResult.output?.text ?? "").trim());
      } catch (err2) {
        return failRun(
          session,
          run,
          `ghcp-maestro/${runId}: plan retry also unparseable: ${err2.message}`,
        );
      }
    }

    await session.log(
      `ghcp-maestro/${runId}: plan produced ${specs.length} subtask(s): ${specs.map((s) => s.agent).join(", ")}`,
    );

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
      log: (msg, options) => session.log(`ghcp-maestro/${runId}: ${msg}`, options),
    });
    if (!gate.approved) {
      // Release first: releaseRun never throws, so the controller can't leak
      // even if persisting the "stopped" status fails.
      releaseRun(runId);
      await run.patchManifest({ status: "stopped" });
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

    // Phase 2 — explore: fan out the planned specs.
    await session.log(`ghcp-maestro/${runId}: phase=explore agents=${specs.length} (parallel)`);
    const exploreSpecs = specs.map((s, i) => ({
      id: `explore-${i}-${sanitizeAgentName(s.agent)}`,
      agent: s.agent,
      prompt: s.prompt,
      timeoutMs: TIMEOUT_AGENT_MS,
    }));
    const { results: exploreResults, elapsedMs: phase1Elapsed } = await runPhase(exploreSpecs, {
      run,
      runId,
      phase: "explore",
      adapter,
    });
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
      );
    }

    // Phase 3 — synth: merge into a single answer to the original task.
    await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
    const synthSpec = {
      id: "synth",
      agent: "synth",
      timeoutMs: TIMEOUT_AGENT_MS,
      prompt: buildSynthPrompt({ task, results: exploreResults }),
    };
    const {
      results: [synth],
      elapsedMs: phase2Elapsed,
    } = await runPhase([synthSpec], { run, runId, phase: "synth", adapter });
    await session.log(synthStatusLine(runId, synth, { wallMs: phase2Elapsed }));
    await session.log(labeledDumpLine(runId, "FINAL ANSWER", synth));

    if (synth.status !== "ok") {
      return failRun(
        session,
        run,
        `ghcp-maestro/${runId}: task failed — synth ${synth.status}: ${synth.error ?? "(no error)"}`,
      );
    }

    await completeRun(run);
    await session.log(
      `ghcp-maestro/${runId}: task workflow complete — ${1 + exploreResults.length + 1} agents across 3 phases (plan + explore[${specs.length}] + synth)`,
    );
    return run;
  }

  return { runHelloWorkflow, runBrainstormWorkflow, runTaskWorkflow };
}
