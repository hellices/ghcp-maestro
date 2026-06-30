// ghcp-maestro extension entry.
// Loaded by the Copilot CLI as a child process; SESSION_ID is injected via env.

import { joinSession } from "@github/copilot-sdk/extension";
import { spawnAll, DEFAULT_CONCURRENCY } from "./runtime/spawn.mjs";
import { createStandaloneClientAdapter } from "./runtime/adapters/standalone-client.mjs";
import { renderDashboard, renderSummary } from "./runtime/monitor.mjs";
import { startPhaseMonitor } from "./runtime/phase-monitor.mjs";
import { isTruthyEnv } from "./runtime/env-flags.mjs";
import { createRun, openRun, listRuns, readRunProgress, defaultBaseDir } from "./runtime/run-store.mjs";
import {
  buildPlanPrompt,
  parseAndValidatePlan,
  sanitizeAgentName,
} from "./runtime/plan.mjs";
import { planApprovalGate } from "./runtime/plan-approval.mjs";
import { failRun } from "./runtime/run-flow.mjs";
import { TIMEOUT_AGENT_MS } from "./runtime/timeouts.mjs";
import {
  runEchoProbe,
  runAgentRegistrySpawnProbe,
  runPongProbe,
  dispatchEnvTriggers,
} from "./runtime/probes.mjs";
import {
  exploreResultLine,
  wallClockLine,
  allFailed,
  agentDigest,
  logExploreResults,
  labeledDumpLine,
  synthStatusLine,
} from "./runtime/workflow-log.mjs";
import {
  defaultWorkflowDirs,
  scanSavedWorkflows,
  loadSavedWorkflow,
  buildWorkflowApi,
  parseWorkflowArgs,
} from "./runtime/saved-workflows.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { renderMaestroHelp } from "./runtime/help.mjs";
import { createMaestroRouter } from "./runtime/maestro-router.mjs";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Saved workflows discovered at startup, keyed by name. Populated before
 * joinSession so they can be exposed via /maestro run and /maestro workflows.
 * @type {Map<string, { name: string, file: string, dir: string }>}
 */
const SAVED_WORKFLOWS = new Map();
let SAVED_WORKFLOWS_SKIPPED = [];

async function discoverSavedWorkflows() {
  try {
    const dirs = defaultWorkflowDirs({ extensionDir: EXTENSION_DIR });
    const { workflows, skipped } = await scanSavedWorkflows(dirs);
    SAVED_WORKFLOWS.clear();
    for (const wf of workflows) SAVED_WORKFLOWS.set(wf.name, wf);
    SAVED_WORKFLOWS_SKIPPED = skipped;
  } catch {
    // Discovery is best-effort; a broken workflows dir must not block the
    // extension from loading.
    SAVED_WORKFLOWS.clear();
    SAVED_WORKFLOWS_SKIPPED = [];
  }
}

await discoverSavedWorkflows();

/** Lazily-initialised adapter shared across handler calls. */
let standaloneAdapter = null;
function getStandaloneAdapter() {
  if (!standaloneAdapter) {
    standaloneAdapter = createStandaloneClientAdapter({
      logger: {
        info: (m) => session.log(`ghcp-maestro/standalone: ${m}`),
        warn: (m) => session.log(`ghcp-maestro/standalone: ${m}`, { level: "warning" }),
      },
    });
  }
  return standaloneAdapter;
}

/**
 * Workflow registry — name → handler. Lets /maestro-resume re-invoke a
 * handler from its persisted manifest.
 *
 * Each handler accepts (session, args, { run }) — `run` is the persisted
 * RunHandle. Re-invoking the same handler with the same args lets spawnAll's
 * cache do the work (M3 resume contract).
 */
const WORKFLOWS = {
  hello: async (session, _args, opts) => runHelloWorkflow(session, opts),
  brainstorm: async (session, args, opts) =>
    runBrainstormWorkflow(session, args?.topic ?? "", opts),
  task: async (session, args, opts) => runTaskWorkflow(session, args?.task ?? "", opts),
};

/**
 * Resolve a workflow handler from a persisted manifest `workflow` field.
 * Built-ins live in WORKFLOWS; saved workflows are stored as `saved:<name>`.
 *
 * @param {string} workflowName
 * @returns {((session: object, args: unknown, opts: object) => Promise<unknown>) | null}
 */
function resolveWorkflowHandler(workflowName) {
  if (WORKFLOWS[workflowName]) return WORKFLOWS[workflowName];
  if (workflowName?.startsWith("saved:")) {
    const name = workflowName.slice("saved:".length);
    return async (session, args, opts) => runSavedWorkflow(session, name, args ?? {}, opts);
  }
  return null;
}

/**
 * Subcommand registry for /maestro. Each entry knows how to validate its
 * arg and dispatch. Centralised here so `/maestro` (no arg) and unknown
 * subcommands both fall through to a uniform help message.
 */
const MAESTRO_SUBCOMMANDS = [
  {
    name: "task",
    needsArg: "task description",
    background: true,
    summary: "Decompose a natural-language task into 3-6 subtasks → run each in an isolated child Copilot session in parallel → synth cross-checks them into a final answer.",
    run: (arg) => runTaskWorkflow(session, arg),
  },
  {
    name: "brainstorm",
    needsArg: "topic",
    background: true,
    summary: "Brainstorm a topic from 4 fixed lenses (tech/ux/biz/risk) in parallel isolated child sessions, then synth derives the TOP 3 actions.",
    run: (arg) => runBrainstormWorkflow(session, arg),
  },
  {
    name: "hello",
    needsArg: false,
    background: true,
    hidden: true,
    summary: "Diagnostic smoke test — fixed 3 explore + 1 synth across isolated child sessions, verifying the fan-out pipeline end-to-end.",
    run: () => runHelloWorkflow(session),
  },
  {
    name: "pong",
    needsArg: "prompt",
    hidden: true,
    summary: "Diagnostic — send one prompt to a single isolated child Copilot session and collect the reply (standalone-client adapter probe).",
    run: (arg) => runPongProbe(session, arg, getStandaloneAdapter()),
  },
  {
    name: "run",
    needsArg: "name [args]",
    background: true,
    summary: "Run a saved workflow (M5). e.g. /maestro run deep-review {\"topic\":\"...\"} — args are JSON or plain text (=> {input}).",
    run: (arg) => runSavedWorkflowCommand(session, arg),
  },
  {
    name: "workflows",
    needsArg: false,
    summary: "List discovered saved workflows (priority: project > user > bundled).",
    run: () => listSavedWorkflows(session),
  },
  {
    name: "help",
    needsArg: false,
    summary: "This help.",
    run: () => Promise.resolve(),
  },
];

async function maestroHelp() {
  await session.log(renderMaestroHelp(MAESTRO_SUBCOMMANDS, { savedWorkflows: [...SAVED_WORKFLOWS.keys()] }));
}

// Shared dispatch — the same router backs the VS Code surface, so subcommand
// parsing/validation/background semantics stay identical across surfaces. Only
// the user-facing messages are surface-owned (session.log here).
const maestroRouter = createMaestroRouter({
  subcommands: MAESTRO_SUBCOMMANDS,
  onHelp: () => maestroHelp(),
  onUnknown: (head) =>
    session.log(
      `ghcp-maestro: unknown subcommand '${head}'. Run '/maestro help' for the list.`,
      { level: "warning" },
    ),
  onMissingArg: (sc) =>
    session.log(
      `ghcp-maestro: /maestro ${sc.name} requires a ${sc.needsArg}. Example: /maestro ${sc.name} <${sc.needsArg}>`,
      { level: "warning" },
    ),
  onBackgroundError: (sc, err) =>
    session.log(`ghcp-maestro: ${sc.name} failed: ${err?.message ?? err}`, {
      level: "error",
    }),
});

const session = await joinSession({
  extensionInfo: {
    source: "ghcp-maestro",
    name: "ghcp-maestro",
  },
  commands: [
    {
      name: "maestro",
      description:
        "Run a ghcp-maestro workflow. Use '/maestro help' to list subcommands.",
      handler: async (ctx) => maestroRouter.dispatch(ctx?.args ?? ""),
    },
    {
      name: "maestros",
      description: "List recent ghcp-maestro workflow runs, or show one run's live dashboard.",
      handler: async (ctx) => {
        const arg = (ctx?.args ?? "").trim();
        if (arg) {
          let snap;
          try {
            snap = await readRunProgress(arg);
          } catch (err) {
            await session.log(
              `ghcp-maestro: cannot read progress for '${arg}': ${err?.message ?? err}`,
              { level: "error" },
            );
            return;
          }
          if (!snap) {
            await session.log(`ghcp-maestro: no progress recorded for run '${arg}' (yet)`);
            return;
          }
          await session.log(renderDashboard(snap));
          return;
        }
        const runs = await listRuns({ limit: 20 });
        if (runs.length === 0) {
          await session.log(`ghcp-maestro: no runs yet under ${defaultBaseDir()}`);
          return;
        }
        await session.log(`ghcp-maestro: ${runs.length} recent run(s) (newest first):`);
        for (const m of runs) {
          const argsPreview = m.args ? JSON.stringify(m.args).slice(0, 80) : "";
          await session.log(
            `  ${m.runId}  workflow=${m.workflow}  status=${m.status}  started=${new Date(m.startedAt).toISOString()}${argsPreview ? `  args=${argsPreview}` : ""}`,
          );
          if (m.status === "running") {
            const snap = await readRunProgress(m.runId).catch(() => undefined);
            if (snap) await session.log(`      ${renderSummary(snap)}`);
          }
        }
        await session.log("ghcp-maestro: open a run's live dashboard with /maestros <runId>");
      },
    },
    {
      name: "maestro-resume",
      description: "Resume a workflow run by id. Cached agent results are reused.",
      handler: async (ctx) => {
        const runId = (ctx?.args ?? "").trim();
        if (!runId) {
          await session.log("ghcp-maestro: /maestro-resume requires a run id", {
            level: "warning",
          });
          return;
        }
        let run;
        try {
          run = await openRun(runId);
        } catch (err) {
          await session.log(`ghcp-maestro: cannot open run '${runId}': ${err?.message ?? err}`, {
            level: "error",
          });
          return;
        }
        const wf = resolveWorkflowHandler(run.manifest.workflow);
        if (!wf) {
          await session.log(
            `ghcp-maestro: workflow '${run.manifest.workflow}' is not registered; can't resume`,
            { level: "warning" },
          );
          return;
        }
        await session.log(
          `ghcp-maestro: resuming ${runId} (workflow=${run.manifest.workflow}, dir=${run.runDir})`,
        );
        await run.patchManifest({ status: "running" });
        try {
          await wf(session, run.manifest.args, { run });
        } catch (err) {
          await failRun(session, run, `ghcp-maestro: resume failed: ${err?.message ?? err}`);
        }
      },
    },
    {
      name: "maestro-stop",
      description: "Mark a workflow run as stopped (does not kill in-flight agents).",
      handler: async (ctx) => {
        const runId = (ctx?.args ?? "").trim();
        if (!runId) {
          await session.log("ghcp-maestro: /maestro-stop requires a run id", {
            level: "warning",
          });
          return;
        }
        try {
          const run = await openRun(runId);
          await run.patchManifest({ status: "stopped", finishedAt: Date.now() });
          await session.log(`ghcp-maestro: marked ${runId} as stopped`);
        } catch (err) {
          await session.log(`ghcp-maestro: cannot stop '${runId}': ${err?.message ?? err}`, {
            level: "error",
          });
        }
      },
    },
  ],
});

await session.log(
  `ghcp-maestro extension loaded. Run '/maestro help' for subcommands.${SAVED_WORKFLOWS.size > 0 ? ` ${SAVED_WORKFLOWS.size} saved workflow(s): ${[...SAVED_WORKFLOWS.keys()].join(", ")}.` : ""}`,
  {
    ephemeral: true,
  },
);
for (const s of SAVED_WORKFLOWS_SKIPPED) {
  await session.log(`ghcp-maestro: skipped workflow ${s.file}: ${s.reason}`, {
    level: "warning",
    ephemeral: true,
  });
}

// --- Probe / workflow env triggers (M2.5/M2.6 measurement) ------------------
//
// Env-triggered entry points for non-interactive validation. Fired fire-and-
// forget (not awaited at the top level) so joinSession() can return and the host
// marks the extension "ready" before we issue any session RPC.
//
//   GHCP_MAESTRO_PROBE_ECHO=<text>        → LLM-mediated adapter on the current session
//   GHCP_MAESTRO_PROBE_REGSPAWN=<text>    → session.rpc.agentRegistry.spawn() probe (B)
//   GHCP_MAESTRO_PROBE_PONG=<text>        → standalone CopilotClient adapter probe (C)
//   GHCP_MAESTRO_PROBE_HELLO=1            → run the full /maestro hello workflow
//   GHCP_MAESTRO_PROBE_BRAINSTORM=<topic> → run the brainstorm workflow
//   GHCP_MAESTRO_PROBE_TASK=<task>        → run the M4 dynamic task workflow
//   GHCP_MAESTRO_PROBE_RUN=<name [args]>  → run a saved workflow
//   GHCP_MAESTRO_PROBE_RESUME=<runId>     → resume the named run (M3)

/**
 * Resume a run named by the env probe. Unlike the interactive /maestro-resume
 * handler (which reports openRun / not-registered / run failures separately), the
 * probe path funnels every failure into one failRun so a half-started run can't
 * hang in "running". Never throws — the dispatcher's catch is a safety net only.
 */
async function resumeRunFromEnv(session, runId) {
  let run;
  try {
    run = await openRun(runId);
    const wf = resolveWorkflowHandler(run.manifest.workflow);
    if (!wf) {
      await session.log(
        `ghcp-maestro: env resume failed — workflow '${run.manifest.workflow}' not registered`,
        { level: "error" },
      );
      return;
    }
    await session.log(`ghcp-maestro: env resume ${run.runId} workflow=${run.manifest.workflow}`);
    await run.patchManifest({ status: "running" });
    await wf(session, run.manifest.args, { run });
  } catch (err) {
    await failRun(session, run, `ghcp-maestro: env resume probe failed: ${err?.message ?? err}`);
  }
}

dispatchEnvTriggers(
  process.env,
  [
    { env: "GHCP_MAESTRO_PROBE_ECHO", label: "echo probe", run: (v) => runEchoProbe(session, v) },
    {
      env: "GHCP_MAESTRO_PROBE_REGSPAWN",
      label: "agentRegistry probe",
      run: (v) => runAgentRegistrySpawnProbe(session, v),
    },
    {
      env: "GHCP_MAESTRO_PROBE_PONG",
      label: "pong probe",
      run: (v) => runPongProbe(session, v, getStandaloneAdapter()),
    },
    {
      env: "GHCP_MAESTRO_PROBE_HELLO",
      label: "hello probe",
      run: (v) => (isTruthyEnv(v) ? runHelloWorkflow(session) : undefined),
    },
    {
      env: "GHCP_MAESTRO_PROBE_BRAINSTORM",
      label: "brainstorm probe",
      run: (v) => runBrainstormWorkflow(session, v),
    },
    { env: "GHCP_MAESTRO_PROBE_TASK", label: "task probe", run: (v) => runTaskWorkflow(session, v) },
    { env: "GHCP_MAESTRO_PROBE_RUN", label: "run probe", run: (v) => runSavedWorkflowCommand(session, v) },
    { env: "GHCP_MAESTRO_PROBE_RESUME", label: "resume probe", run: (v) => resumeRunFromEnv(session, v) },
  ],
  {
    onError: (label, err) =>
      session.log(`ghcp-maestro: env ${label} failed: ${err?.message ?? err}`, { level: "error" }),
  },
);

// --- Hello workflow (diagnostic smoke test, standalone adapter) --------------

/**
 * Two-phase diagnostic smoke test exercised end-to-end with the standalone-client
 * adapter, so each "agent" is a real isolated Copilot CLI child session. Fixed
 * prompts (ALPHA/BRAVO/CHARLIE → joined) verify the fan-out pipeline works; not
 * a user-facing feature (hidden from /maestro help, kept for infra validation).
 *   phase explore  → 3 child sessions in parallel
 *   phase synth    → 1 child session that summarises the explore results
 *
 * The host's conversation context never sees the per-agent prompts — only
 * the structured summary we log here.
 */
async function runHelloWorkflow(session, opts = {}) {
  const run = opts.run ?? (await createRun({ workflow: "hello" }));
  const runId = run.runId;
  const adapter = getStandaloneAdapter();
  await session.log(
    `ghcp-maestro/${runId}: starting hello workflow (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
  );
  if (!opts.run) {
    await session.log(`ghcp-maestro/${runId}: running in background — watch with /maestros ${runId}`);
  }

  // Phase 1 — explore (fan-out)
  await session.log(`ghcp-maestro/${runId}: phase=explore agents=3 (parallel)`);
  const exploreSpecs = [
    {
      id: "explore-a",
      prompt:
        "Reply with the single word ALPHA. No punctuation, no explanation.",
      agent: "explore-a",
      timeoutMs: TIMEOUT_AGENT_MS,
    },
    {
      id: "explore-b",
      prompt:
        "Reply with the single word BRAVO. No punctuation, no explanation.",
      agent: "explore-b",
      timeoutMs: TIMEOUT_AGENT_MS,
    },
    {
      id: "explore-c",
      prompt:
        "Reply with the single word CHARLIE. No punctuation, no explanation.",
      agent: "explore-c",
      timeoutMs: TIMEOUT_AGENT_MS,
    },
  ];
  const monitor = startPhaseMonitor({ runId, run, phase: "explore", specs: exploreSpecs });
  const t1 = Date.now();
  const exploreResults = await spawnAll(exploreSpecs, {
    adapter,
    runHandle: run,
    onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
  });
  for (const r of exploreResults) monitor?.settle(r.spec.id, r.status === "ok");
  monitor?.flush();
  const phase1Elapsed = Date.now() - t1;
  for (const r of exploreResults) {
    await session.log(exploreResultLine(runId, r, { mode: "reply" }));
  }
  await session.log(wallClockLine(runId, phase1Elapsed, 3));

  // Phase 2 — synth (uses outputs from phase 1)
  await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
  const collected = exploreResults
    .map((r) => `- ${r.spec.agent}: ${(r.output?.text ?? "").trim()}`)
    .join("\n");
  const t2 = Date.now();
  const synthSpec = {
    id: "synth",
    prompt: `Three explore agents replied below. Join their replies with a single space, in the order they appear, and reply with only that joined string — no punctuation, no explanation.\n\n${collected}`,
    agent: "synth",
    timeoutMs: TIMEOUT_AGENT_MS,
  };
  const synthMonitor = startPhaseMonitor({ runId, run, phase: "synth", specs: [synthSpec] });
  const [synth] = await spawnAll([synthSpec], {
    adapter,
    runHandle: run,
    onProgress: synthMonitor ? (e) => synthMonitor.onProgress(e) : undefined,
  });
  synthMonitor?.settle(synth.spec.id, synth.status === "ok");
  synthMonitor?.flush();
  const phase2Elapsed = Date.now() - t2;
  const synthText = (synth.output?.text ?? "").trim();
  await session.log(
    `ghcp-maestro/${runId}: synth status=${synth.status}${synth.cached ? " (cached)" : ""} took=${synth.finishedAt - synth.startedAt}ms wall=${phase2Elapsed}ms reply=${JSON.stringify(synthText.slice(0, 80))}`,
  );

  await run.complete();
  await session.log(
    `ghcp-maestro/${runId}: hello workflow complete (${exploreResults.length + 1} agents across 2 phases)`,
  );
  return run;
}

// --- Brainstorm workflow ----------------------------------------------------

/**
 * Real-world multi-angle brainstorm.
 *
 *   phase explore  → 4 isolated child sessions, each tackling the same topic
 *                    from a different perspective (technical, UX, business, risk).
 *   phase synth    → 1 child session that merges the 4 perspectives into a
 *                    structured plan with the strongest 3 actions to take next.
 *
 * Demonstrates real fan-out: the four explore agents run in parallel; the
 * host's conversation history never sees their internal reasoning, only the
 * compact summaries we log here.
 */
async function runBrainstormWorkflow(session, topic, opts = {}) {
  const run = opts.run ?? (await createRun({ workflow: "brainstorm", args: { topic } }));
  const runId = run.runId;
  const adapter = getStandaloneAdapter();
  await session.log(
    `ghcp-maestro/${runId}: brainstorm "${topic.slice(0, 80)}" (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
  );
  if (!opts.run) {
    await session.log(`ghcp-maestro/${runId}: running in background — watch with /maestros ${runId}`);
  }

  const angles = [
    {
      agent: "tech",
      lens: "Technical / implementation",
      ask:
        "What are the most important technical considerations, architectural choices, and likely failure modes?",
    },
    {
      agent: "ux",
      lens: "User experience",
      ask:
        "Who are the users, what jobs are they hiring this to do, and what would make or break their daily experience?",
    },
    {
      agent: "biz",
      lens: "Business / strategy",
      ask:
        "What is the value proposition, how does it compare to alternatives, and what would need to be true for it to be worth doing?",
    },
    {
      agent: "risk",
      lens: "Risks and unknowns",
      ask:
        "What could go wrong, what assumptions are most fragile, and which questions must be answered before committing?",
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

  const monitor = startPhaseMonitor({ runId, run, phase: "explore", specs });
  const t1 = Date.now();
  const results = await spawnAll(specs, {
    adapter,
    runHandle: run,
    onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
  });
  for (const r of results) monitor?.settle(r.spec.id, r.status === "ok");
  monitor?.flush();
  const phase1Elapsed = Date.now() - t1;

  await logExploreResults({
    runId,
    results,
    elapsedMs: phase1Elapsed,
    count: angles.length,
    label: "explore",
    log: (msg, opts) => session.log(msg, opts),
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

  const t2 = Date.now();
  const synthSpec = { id: "synth", agent: "synth", prompt: synthPrompt, timeoutMs: TIMEOUT_AGENT_MS };
  const synthMonitor = startPhaseMonitor({ runId, run, phase: "synth", specs: [synthSpec] });
  const [synth] = await spawnAll([synthSpec], {
    adapter,
    runHandle: run,
    onProgress: synthMonitor ? (e) => synthMonitor.onProgress(e) : undefined,
  });
  synthMonitor?.settle(synth.spec.id, synth.status === "ok");
  synthMonitor?.flush();
  const phase2Elapsed = Date.now() - t2;
  await session.log(synthStatusLine(runId, synth));
  await session.log(labeledDumpLine(runId, "TOP 3 NEXT STEPS", synth));

  if (synth.status !== "ok") {
    return failRun(
      session,
      run,
      `ghcp-maestro/${runId}: brainstorm failed — synth ${synth.status}: ${synth.error ?? "(no error)"}`,
    );
  }

  await run.complete();
  await session.log(
    `ghcp-maestro/${runId}: brainstorm complete — ${results.length + 1} agents across 2 phases (phase1=${phase1Elapsed}ms parallel, phase2=${phase2Elapsed}ms)`,
  );
  return run;
}

// --- Task workflow (M4 — LLM-driven task decomposition) ---------------------

/**
 * Generic dynamic-workflow runner: take an arbitrary natural-language task
 * and let an LLM decompose it into independent subtasks, then fan them out.
 *
 *   phase plan   → 1 standalone agent reads the task and returns a JSON spec
 *                  array: [{ agent, prompt, lens? }]. Re-asked once on parse
 *                  failure with the parser error included.
 *   phase explore → spawnAll(specs) — real isolated child Copilot sessions,
 *                   one per subtask, capped by DEFAULT_CONCURRENCY.
 *   phase synth   → 1 standalone agent merges the per-subtask outputs into a
 *                   final answer aimed at the original task.
 *
 * All three phases share a RunHandle, so any subagent that already succeeded
 * before a crash is replayed from cache on /maestro-resume.
 */
async function runTaskWorkflow(session, task, opts = {}) {
  const run = opts.run ?? (await createRun({ workflow: "task", args: { task } }));
  const runId = run.runId;
  const adapter = getStandaloneAdapter();
  await session.log(
    `ghcp-maestro/${runId}: task "${task.slice(0, 80)}" (adapter=${adapter.name}, concurrency=${DEFAULT_CONCURRENCY}, dir=${run.runDir})`,
  );
  if (!opts.run) {
    await session.log(`ghcp-maestro/${runId}: running in background — watch with /maestros ${runId}`);
  }

  // Phase 1 — plan: ask the LLM to decompose the task.
  await session.log(`ghcp-maestro/${runId}: phase=plan agents=1`);
  const planSpec = {
    id: "plan",
    agent: "plan",
    timeoutMs: TIMEOUT_AGENT_MS,
    prompt: buildPlanPrompt(task),
  };
  const planMonitor = startPhaseMonitor({ runId, run, phase: "plan", specs: [planSpec] });
  const [planResult] = await spawnAll([planSpec], {
    adapter,
    runHandle: run,
    onProgress: planMonitor ? (e) => planMonitor.onProgress(e) : undefined,
  });
  planMonitor?.settle(planResult.spec.id, planResult.status === "ok");
  planMonitor?.flush();
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
    const retryMonitor = startPhaseMonitor({ runId, run, phase: "plan", specs: [retrySpec] });
    const [retryResult] = await spawnAll([retrySpec], {
      adapter,
      runHandle: run,
      onProgress: retryMonitor ? (e) => retryMonitor.onProgress(e) : undefined,
    });
    retryMonitor?.settle(retryResult.spec.id, retryResult.status === "ok");
    retryMonitor?.flush();
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
    isTruthyEnv(process.env.GHCP_MAESTRO_AUTO_APPROVE) ||
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
  const monitor = startPhaseMonitor({ runId, run, phase: "explore", specs: exploreSpecs });
  const t1 = Date.now();
  const exploreResults = await spawnAll(exploreSpecs, {
    adapter,
    runHandle: run,
    onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
  });
  for (const r of exploreResults) monitor?.settle(r.spec.id, r.status === "ok");
  monitor?.flush();
  const phase1Elapsed = Date.now() - t1;
  await logExploreResults({
    runId,
    results: exploreResults,
    elapsedMs: phase1Elapsed,
    count: specs.length,
    label: "subtask",
    log: (msg, opts) => session.log(msg, opts),
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
  const digest = agentDigest(exploreResults, { emptyPlaceholder: "(no output)" });
  const synthSpec = {
    id: "synth",
    agent: "synth",
    timeoutMs: TIMEOUT_AGENT_MS,
    prompt: [
      "You are a synthesis agent. Several independent subagents tackled different parts of a single task.",
      "Merge their outputs into a coherent final answer to the original task.",
      "Be concrete, deduplicate, surface disagreements, and end with a short 'next actions' list of at most 5 items.",
      "",
      `Original task: ${task}`,
      "",
      "Subagent outputs:",
      digest,
    ].join("\n"),
  };
  const t2 = Date.now();
  const synthMonitor = startPhaseMonitor({ runId, run, phase: "synth", specs: [synthSpec] });
  const [synth] = await spawnAll([synthSpec], {
    adapter,
    runHandle: run,
    onProgress: synthMonitor ? (e) => synthMonitor.onProgress(e) : undefined,
  });
  synthMonitor?.settle(synth.spec.id, synth.status === "ok");
  synthMonitor?.flush();
  const phase2Elapsed = Date.now() - t2;
  await session.log(synthStatusLine(runId, synth, { wallMs: phase2Elapsed }));
  await session.log(labeledDumpLine(runId, "FINAL ANSWER", synth));

  if (synth.status !== "ok") {
    return failRun(
      session,
      run,
      `ghcp-maestro/${runId}: task failed — synth ${synth.status}: ${synth.error ?? "(no error)"}`,
    );
  }

  await run.complete();
  await session.log(
    `ghcp-maestro/${runId}: task workflow complete — ${1 + exploreResults.length + 1} agents across 3 phases (plan + explore[${specs.length}] + synth)`,
  );
  return run;
}

// --- Saved workflows (M5) ---------------------------------------------------

/**
 * List the saved workflows discovered at startup.
 */
async function listSavedWorkflows(session) {
  if (SAVED_WORKFLOWS.size === 0) {
    await session.log(
      "ghcp-maestro: no saved workflows found. Drop a <name>.mjs into ./.ghcp-maestro/workflows, ~/.copilot/plugin-data/ghcp-maestro/workflows, or the bundled saved-workflows dir.",
    );
    return;
  }
  await session.log(`ghcp-maestro: ${SAVED_WORKFLOWS.size} saved workflow(s):`);
  for (const wf of SAVED_WORKFLOWS.values()) {
    let description;
    try {
      ({ description } = await loadSavedWorkflow(wf.file));
    } catch (err) {
      description = `(failed to load: ${err?.message ?? err})`;
    }
    await session.log(`  /maestro run ${wf.name}  —  ${description}  [${wf.dir}]`);
  }
}

/**
 * Parse `<name> [args]` from a /maestro run argument string and dispatch.
 */
async function runSavedWorkflowCommand(session, arg) {
  const trimmed = (arg ?? "").trim();
  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  if (!name) {
    await session.log(
      "ghcp-maestro: /maestro run requires a workflow name. See /maestro workflows.",
      { level: "warning" },
    );
    return;
  }
  if (!SAVED_WORKFLOWS.has(name)) {
    await session.log(
      `ghcp-maestro: no saved workflow named '${name}'. See /maestro workflows.`,
      { level: "warning" },
    );
    return;
  }
  const args = parseWorkflowArgs(rest);
  await runSavedWorkflow(session, name, args);
}

/**
 * Execute a saved workflow by name. Wires a RunStore run (workflow=`saved:<name>`)
 * so the run shows in /maestros and can be resumed, and injects the sandboxed
 * api built by buildWorkflowApi.
 */
async function runSavedWorkflow(session, name, args, opts = {}) {
  const descriptor = SAVED_WORKFLOWS.get(name);
  if (!descriptor) {
    // When invoked via resume, opts.run was already flipped to "running" by the
    // caller; mark it error so it can't hang forever as a running run.
    return failRun(session, opts.run, `ghcp-maestro: saved workflow '${name}' is no longer available`);
  }
  const run = opts.run ?? (await createRun({ workflow: `saved:${name}`, args }));
  const runId = run.runId;
  const adapter = getStandaloneAdapter();
  await session.log(
    `ghcp-maestro/${runId}: saved workflow '${name}' (file=${descriptor.file}, dir=${run.runDir})`,
  );

  let mod;
  try {
    mod = await loadSavedWorkflow(descriptor.file);
  } catch (err) {
    return failRun(
      session,
      run,
      `ghcp-maestro/${runId}: failed to load '${name}': ${err?.message ?? err}`,
    );
  }

  const api = buildWorkflowApi({
    session,
    adapter,
    run,
    args: args ?? {},
    concurrency: DEFAULT_CONCURRENCY,
    namespace: `${runId}/${name}`,
  });

  try {
    await mod.run(api);
    await run.complete();
    await session.log(`ghcp-maestro/${runId}: saved workflow '${name}' complete`);
  } catch (err) {
    await failRun(session, run, `ghcp-maestro/${runId}: saved workflow '${name}' failed: ${err?.message ?? err}`);
  }
  return run;
}
