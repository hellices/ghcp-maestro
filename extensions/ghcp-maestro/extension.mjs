// ghcp-maestro extension entry.
// Loaded by the Copilot CLI as a child process; SESSION_ID is injected via env.

import { joinSession } from "@github/copilot-sdk/extension";
import { DEFAULT_CONCURRENCY } from "../../core/spawn.mjs";
import { createStandaloneClientAdapter } from "../../core/adapters/standalone-client.mjs";
import { createRun, openRun } from "../../core/run-store.mjs";
import { isTruthyEnv } from "../../core/env-flags.mjs";
import { failRun, completeRun } from "../../core/run-flow.mjs";
import { ensureRunController } from "../../core/run-registry.mjs";
import { createBuiltinWorkflows } from "../../core/builtin-workflows.mjs";
import { showRuns, resumeRun, stopRun } from "../../core/run-commands.mjs";
import {
  runEchoProbe,
  runAgentRegistrySpawnProbe,
  runPongProbe,
  dispatchEnvTriggers,
} from "../../core/probes.mjs";
import {
  defaultWorkflowDirs,
  scanSavedWorkflows,
  loadSavedWorkflow,
  buildWorkflowApi,
  parseWorkflowArgs,
  splitWorkflowInvocation,
} from "../../core/saved-workflows.mjs";
import { installWorkflowCommand } from "../../core/workflow-install.mjs";
import { composeWorkflowCommand } from "../../core/workflow-compose.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { renderMaestroHelp, TASK_COMMAND_SUMMARY } from "../../core/help.mjs";
import { createMaestroRouter } from "../../core/maestro-router.mjs";

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

// Built-in workflow handlers, composed over the shared standalone adapter. The
// bodies live in core/builtin-workflows.mjs so extension.mjs stays a thin
// composition root and the workflows remain unit-testable off the SDK.
const { runHelloWorkflow, runBrainstormWorkflow, runTaskWorkflow } = createBuiltinWorkflows({
  getAdapter: getStandaloneAdapter,
});

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
    summary: TASK_COMMAND_SUMMARY,
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
    name: "install",
    needsArg: "github source [--force]",
    summary: "Install a saved workflow from GitHub into the user workflow dir. e.g. /maestro install owner/repo/path/flow.mjs[@ref] or a github.com blob URL.",
    run: (arg) => installWorkflowCommand(session, arg),
  },
  {
    name: "compose",
    needsArg: "description [--name <kebab>] [--force]",
    background: true,
    summary: "Generate a saved workflow from a natural-language description (planner agent → static validation → review gate → echo dry-run → saved to the project workflow dir).",
    run: (arg) => composeWorkflowCommand(session, arg, { getAdapter: getStandaloneAdapter }),
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
      handler: async (ctx) => showRuns(session, ctx?.args ?? ""),
    },
    {
      name: "maestro-resume",
      description: "Resume a workflow run by id. Cached agent results are reused.",
      handler: async (ctx) => resumeRun(session, ctx?.args ?? "", { resolveWorkflowHandler }),
    },
    {
      name: "maestro-stop",
      description: "Stop a workflow run: mark it stopped and abort its in-flight agents (when started in this session).",
      handler: async (ctx) => stopRun(session, ctx?.args ?? ""),
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

// --- Saved workflows (M5) ---------------------------------------------------

/**
 * List the saved workflows, rescanning the workflow dirs first so files added
 * or removed since startup are reflected without restarting the CLI.
 */
async function listSavedWorkflows(session) {
  await discoverSavedWorkflows();
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
  const { name, rest } = splitWorkflowInvocation(arg);
  if (!name) {
    await session.log(
      "ghcp-maestro: /maestro run requires a workflow name. See /maestro workflows.",
      { level: "warning" },
    );
    return;
  }
  if (!SAVED_WORKFLOWS.has(name)) {
    // The startup scan may be stale (workflow file added since launch) — rescan
    // once before giving up.
    await discoverSavedWorkflows();
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
    // Wire the run's process-local controller so /maestro-stop aborts the
    // workflow's spawned agents, matching the built-in workflows.
    signal: ensureRunController(runId).signal,
    namespace: `${runId}/${name}`,
  });

  try {
    await mod.run(api);
    await completeRun(run);
    await session.log(`ghcp-maestro/${runId}: saved workflow '${name}' complete`);
  } catch (err) {
    await failRun(session, run, `ghcp-maestro/${runId}: saved workflow '${name}' failed: ${err?.message ?? err}`);
  }
  return run;
}
