// ghcp-maestro extension entry.
// Loaded by the Copilot CLI as a child process; SESSION_ID is injected via env.

import { joinSession } from "@github/copilot-sdk/extension";
import { spawn, spawnAll, DEFAULT_CONCURRENCY } from "./runtime/spawn.mjs";
import { createLlmMediatedAdapter } from "./runtime/adapters/llm-mediated.mjs";
import { createStandaloneClientAdapter } from "./runtime/adapters/standalone-client.mjs";
import { createRun, openRun, listRuns, defaultBaseDir } from "./runtime/run-store.mjs";

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
 * Subcommand registry for /maestro. Each entry knows how to validate its
 * arg and dispatch. Centralised here so `/maestro` (no arg) and unknown
 * subcommands both fall through to a uniform help message.
 */
const MAESTRO_SUBCOMMANDS = [
  {
    name: "task",
    needsArg: "task description",
    summary: "LLM 이 자연어 task 를 3-6 subtask 로 자동 분할 → 격리된 child Copilot 세션에서 진짜 병렬 실행 → synth 가 cross-check 후 최종 답변",
    run: (arg) => runTaskWorkflow(session, arg),
  },
  {
    name: "brainstorm",
    needsArg: "topic",
    summary: "고정 4-각도 (tech/ux/biz/risk) 데모. 각 lens 가 격리된 child session 에서 동시 실행 후 synth 가 TOP 3 actions 도출.",
    run: (arg) => runBrainstormWorkflow(session, arg),
  },
  {
    name: "hello",
    needsArg: false,
    summary: "M2.6 데모 — 3 explore + 1 synth 고정 스크립트, 모두 격리된 child session.",
    run: () => runHelloWorkflow(session),
  },
  {
    name: "pong",
    needsArg: "prompt",
    summary: "단일 격리된 child Copilot session 에 prompt 1번 송신 → 응답 회수 (standalone-client adapter 진단용).",
    run: (arg) => runPongProbe(session, arg),
  },
  {
    name: "help",
    needsArg: false,
    summary: "이 도움말.",
    run: () => Promise.resolve(),
  },
];

async function maestroHelp() {
  const lines = ["ghcp-maestro: available /maestro subcommands"];
  for (const sc of MAESTRO_SUBCOMMANDS) {
    const usage = sc.needsArg ? `/maestro ${sc.name} <${sc.needsArg}>` : `/maestro ${sc.name}`;
    lines.push(`  ${usage}`);
    lines.push(`    ${sc.summary}`);
  }
  lines.push("");
  lines.push("Run management:");
  lines.push("  /maestros                     list recent runs (newest first)");
  lines.push("  /maestro-resume <runId>       replay a run; cached agents reused, missing ones rerun");
  lines.push("  /maestro-stop <runId>         mark a run as stopped");
  await session.log(lines.join("\n"));
}

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
      handler: async (ctx) => {
        const arg = (ctx?.args ?? "").trim();
        if (arg === "" || arg === "help" || arg === "--help" || arg === "-h") {
          await maestroHelp();
          return;
        }
        const spaceIdx = arg.indexOf(" ");
        const head = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
        const tail = spaceIdx === -1 ? "" : arg.slice(spaceIdx + 1).trim();
        const sc = MAESTRO_SUBCOMMANDS.find((c) => c.name === head);
        if (!sc) {
          await session.log(
            `ghcp-maestro: unknown subcommand '${head}'. Run '/maestro help' for the list.`,
            { level: "warning" },
          );
          return;
        }
        if (sc.name === "help") {
          await maestroHelp();
          return;
        }
        if (sc.needsArg && !tail) {
          await session.log(
            `ghcp-maestro: /maestro ${sc.name} requires a ${sc.needsArg}. Example: /maestro ${sc.name} <${sc.needsArg}>`,
            { level: "warning" },
          );
          return;
        }
        await sc.run(tail);
      },
    },
    {
      name: "maestros",
      description: "List recent ghcp-maestro workflow runs.",
      handler: async () => {
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
        }
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
        const wf = WORKFLOWS[run.manifest.workflow];
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
          await run.patchManifest({ status: "error" });
          await session.log(`ghcp-maestro: resume failed: ${err?.message ?? err}`, {
            level: "error",
          });
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

await session.log("ghcp-maestro extension loaded (M4 release). Run '/maestro help' for subcommands.", {
  ephemeral: true,
});

// --- Probe trigger (M2.5/M2.6 measurement) ---------------------------------
//
// Env-triggered probes for non-interactive validation:
//   GHCP_MAESTRO_PROBE_ECHO=<text>      → LLM-mediated adapter on the current session
//   GHCP_MAESTRO_PROBE_REGSPAWN=<text>  → session.rpc.agentRegistry.spawn() probe (B)
//   GHCP_MAESTRO_PROBE_PONG=<text>      → standalone CopilotClient adapter probe (C)
//   GHCP_MAESTRO_PROBE_HELLO=1          → run the full /maestro hello workflow
//   GHCP_MAESTRO_PROBE_BRAINSTORM=<topic> → run the brainstorm workflow
//   GHCP_MAESTRO_PROBE_TASK=<task>      → run the M4 dynamic task workflow
//   GHCP_MAESTRO_PROBE_RESUME=<runId>   → resume the named run (M3)
//
// Not awaited at the top level — let joinSession() return first so the host
// considers the extension "ready" before we issue any session RPC.
const envEcho = process.env.GHCP_MAESTRO_PROBE_ECHO;
if (envEcho && envEcho.trim().length > 0) {
  runEchoProbe(session, envEcho.trim()).catch(async (err) => {
    await session.log(`ghcp-maestro: env echo probe failed: ${err?.message ?? err}`, {
      level: "error",
    });
  });
}
const envRegSpawn = process.env.GHCP_MAESTRO_PROBE_REGSPAWN;
if (envRegSpawn && envRegSpawn.trim().length > 0) {
  runAgentRegistrySpawnProbe(session, envRegSpawn.trim()).catch(async (err) => {
    await session.log(
      `ghcp-maestro: env agentRegistry probe failed: ${err?.message ?? err}`,
      { level: "error" },
    );
  });
}
const envPong = process.env.GHCP_MAESTRO_PROBE_PONG;
if (envPong && envPong.trim().length > 0) {
  runPongProbe(session, envPong.trim()).catch(async (err) => {
    await session.log(`ghcp-maestro: env pong probe failed: ${err?.message ?? err}`, {
      level: "error",
    });
  });
}
const envHello = process.env.GHCP_MAESTRO_PROBE_HELLO;
if (envHello && envHello.trim().length > 0) {
  runHelloWorkflow(session).catch(async (err) => {
    await session.log(`ghcp-maestro: env hello probe failed: ${err?.message ?? err}`, {
      level: "error",
    });
  });
}
const envBrainstorm = process.env.GHCP_MAESTRO_PROBE_BRAINSTORM;
if (envBrainstorm && envBrainstorm.trim().length > 0) {
  runBrainstormWorkflow(session, envBrainstorm.trim()).catch(async (err) => {
    await session.log(
      `ghcp-maestro: env brainstorm probe failed: ${err?.message ?? err}`,
      { level: "error" },
    );
  });
}
const envTask = process.env.GHCP_MAESTRO_PROBE_TASK;
if (envTask && envTask.trim().length > 0) {
  runTaskWorkflow(session, envTask.trim()).catch(async (err) => {
    await session.log(`ghcp-maestro: env task probe failed: ${err?.message ?? err}`, {
      level: "error",
    });
  });
}
const envResume = process.env.GHCP_MAESTRO_PROBE_RESUME;
if (envResume && envResume.trim().length > 0) {
  (async () => {
    try {
      const run = await openRun(envResume.trim());
      const wf = WORKFLOWS[run.manifest.workflow];
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
      await session.log(`ghcp-maestro: env resume probe failed: ${err?.message ?? err}`, {
        level: "error",
      });
    }
  })();
}

// --- Hello workflow (standalone adapter, M2.6) ------------------------------

/**
 * Two-phase demo workflow exercised end-to-end with the standalone-client
 * adapter, so each "agent" is a real isolated Copilot CLI child session.
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

  // Phase 1 — explore (fan-out)
  await session.log(`ghcp-maestro/${runId}: phase=explore agents=3 (parallel)`);
  const exploreSpecs = [
    {
      id: "explore-a",
      prompt:
        "Reply with the single word ALPHA. No punctuation, no explanation.",
      agent: "explore-a",
      timeoutMs: 60_000,
    },
    {
      id: "explore-b",
      prompt:
        "Reply with the single word BRAVO. No punctuation, no explanation.",
      agent: "explore-b",
      timeoutMs: 60_000,
    },
    {
      id: "explore-c",
      prompt:
        "Reply with the single word CHARLIE. No punctuation, no explanation.",
      agent: "explore-c",
      timeoutMs: 60_000,
    },
  ];
  const t1 = Date.now();
  const exploreResults = await spawnAll(exploreSpecs, { adapter, runHandle: run });
  const phase1Elapsed = Date.now() - t1;
  for (const r of exploreResults) {
    const preview = (r.output?.text ?? "").trim().slice(0, 40);
    await session.log(
      `ghcp-maestro/${runId}: explore/${r.spec.agent} status=${r.status}${r.cached ? " (cached)" : ""} took=${r.finishedAt - r.startedAt}ms reply=${JSON.stringify(preview)}`,
    );
  }
  await session.log(
    `ghcp-maestro/${runId}: phase=explore wall-clock=${phase1Elapsed}ms (parallel of 3)`,
  );

  // Phase 2 — synth (uses outputs from phase 1)
  await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
  const collected = exploreResults
    .map((r) => `- ${r.spec.agent}: ${(r.output?.text ?? "").trim()}`)
    .join("\n");
  const t2 = Date.now();
  const [synth] = await spawnAll(
    [
      {
        id: "synth",
        prompt: `Three explore agents replied below. Join their replies with a single space, in the order they appear, and reply with only that joined string — no punctuation, no explanation.\n\n${collected}`,
        agent: "synth",
        timeoutMs: 60_000,
      },
    ],
    { adapter, runHandle: run },
  );
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

function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Echo probe (LLM-mediated adapter, M2.5) --------------------------------

/**
 * Single-spec probe used to measure end-to-end LLM-mediated round-trip:
 *   - Can an extension command handler call session.sendAndWait?
 *   - Does displayPrompt render in the timeline?
 *   - Do we get an AssistantMessageEvent back inside the handler?
 *
 * Sends ONE spec through the LLM adapter and logs the round-trip + reply
 * length. If sendAndWait deadlocks against the handler's own turn, this
 * probe is where we will find out.
 */
async function runEchoProbe(session, prompt) {
  const runId = newRunId();
  const adapter = createLlmMediatedAdapter({ session });
  await session.log(
    `ghcp-maestro/${runId}: echo probe (adapter=${adapter.name}, prompt=${JSON.stringify(prompt)})`,
  );
  const t0 = Date.now();
  const result = await spawn(
    { prompt, agent: "echo", id: `${runId}-echo`, timeoutMs: 30_000 },
    { adapter },
  );
  const elapsed = Date.now() - t0;
  if (result.status === "ok") {
    const text = (result.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: echo ok in ${elapsed}ms; reply chars=${text.length}; preview=${JSON.stringify(text.slice(0, 120))}`,
    );
  } else {
    await session.log(
      `ghcp-maestro/${runId}: echo ${result.status} in ${elapsed}ms: ${result.error ?? "(no error message)"}`,
      { level: "warning" },
    );
  }
}

// --- agentRegistry.spawn probe (M2.6 B) -------------------------------------

/**
 * Calls session.rpc.agentRegistry.spawn() with a minimal payload to find out
 * whether the controller-local spawn gate is open in our context. When the
 * gate is closed the SDK returns a JSON-RPC MethodNotFound — so we report
 * exactly what came back without throwing.
 */
async function runAgentRegistrySpawnProbe(session, prompt) {
  const runId = newRunId();
  await session.log(
    `ghcp-maestro/${runId}: agentRegistry.spawn probe starting (prompt=${JSON.stringify(prompt)})`,
  );
  const cwd = process.env.COPILOT_CLI_CWD ?? process.cwd();
  const t0 = Date.now();
  try {
    const rpc = session.rpc;
    if (!rpc?.agentRegistry?.spawn) {
      await session.log(
        `ghcp-maestro/${runId}: session.rpc.agentRegistry.spawn is undefined; SDK surface missing`,
        { level: "warning" },
      );
      return;
    }
    const result = await rpc.agentRegistry.spawn({
      cwd,
      name: `ghcp-maestro-probe-${runId}`,
      initialPrompt: prompt,
    });
    const elapsed = Date.now() - t0;
    await session.log(
      `ghcp-maestro/${runId}: agentRegistry.spawn returned kind=${result?.kind} in ${elapsed}ms — ${JSON.stringify(result).slice(0, 400)}`,
    );
  } catch (err) {
    const elapsed = Date.now() - t0;
    await session.log(
      `ghcp-maestro/${runId}: agentRegistry.spawn threw after ${elapsed}ms: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
      { level: "warning" },
    );
  }
}

// --- Pong probe (standalone-client adapter, M2.6 C) -------------------------

/**
 * Drives the standalone CopilotClient adapter end-to-end with a single spec.
 * On success the reply text is logged back into the host session. Failure
 * surfaces the adapter's error message verbatim so we know whether nested
 * Copilot CLI spawn / auth / RPC works in this environment.
 */
async function runPongProbe(session, prompt) {
  const runId = newRunId();
  const adapter = getStandaloneAdapter();
  await session.log(
    `ghcp-maestro/${runId}: pong probe (adapter=${adapter.name}, prompt=${JSON.stringify(prompt)})`,
  );
  const t0 = Date.now();
  const result = await spawn(
    { prompt, agent: "pong", id: `${runId}-pong`, timeoutMs: 60_000 },
    { adapter },
  );
  const elapsed = Date.now() - t0;
  if (result.status === "ok") {
    const text = (result.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: pong ok in ${elapsed}ms; childSessionId=${result.output?.sessionId ?? "?"}; chars=${text.length}; preview=${JSON.stringify(text.slice(0, 200))}`,
    );
  } else {
    await session.log(
      `ghcp-maestro/${runId}: pong ${result.status} in ${elapsed}ms: ${result.error ?? "(no error message)"}`,
      { level: "warning" },
    );
  }
}

// --- Brainstorm workflow (M2.6 demo) ----------------------------------------

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
    timeoutMs: 90_000,
  }));

  const t1 = Date.now();
  const results = await spawnAll(specs, { adapter, runHandle: run });
  const phase1Elapsed = Date.now() - t1;

  for (const r of results) {
    const text = (r.output?.text ?? "").trim();
    const firstLine = text.split("\n")[0] ?? "";
    await session.log(
      `ghcp-maestro/${runId}: explore/${r.spec.agent} status=${r.status}${r.cached ? " (cached)" : ""} took=${r.finishedAt - r.startedAt}ms chars=${text.length} preview=${JSON.stringify(firstLine.slice(0, 100))}`,
    );
  }
  await session.log(
    `ghcp-maestro/${runId}: phase=explore wall-clock=${phase1Elapsed}ms (parallel of ${angles.length})`,
  );

  for (const r of results) {
    await session.log(
      `ghcp-maestro/${runId}: explore/${r.spec.agent} FULL ↓\n${(r.output?.text ?? "(empty)").trim()}`,
    );
  }

  // Phase 2 — synth
  await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
  const digest = results
    .map((r) => `## ${r.spec.agent}\n${(r.output?.text ?? "").trim()}`)
    .join("\n\n");
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
  const [synth] = await spawnAll(
    [{ id: "synth", agent: "synth", prompt: synthPrompt, timeoutMs: 120_000 }],
    { adapter, runHandle: run },
  );
  const phase2Elapsed = Date.now() - t2;
  await session.log(
    `ghcp-maestro/${runId}: synth status=${synth.status}${synth.cached ? " (cached)" : ""} took=${synth.finishedAt - synth.startedAt}ms`,
  );
  await session.log(
    `ghcp-maestro/${runId}: TOP 3 NEXT STEPS ↓\n${(synth.output?.text ?? "(empty)").trim()}`,
  );

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

  // Phase 1 — plan: ask the LLM to decompose the task.
  await session.log(`ghcp-maestro/${runId}: phase=plan agents=1`);
  const planSpec = {
    id: "plan",
    agent: "plan",
    timeoutMs: 120_000,
    prompt: buildPlanPrompt(task),
  };
  const [planResult] = await spawnAll([planSpec], { adapter, runHandle: run });
  if (planResult.status !== "ok") {
    await run.patchManifest({ status: "error" });
    await session.log(
      `ghcp-maestro/${runId}: plan agent ${planResult.status}: ${planResult.error ?? "(no error)"}`,
      { level: "error" },
    );
    return run;
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
      timeoutMs: 120_000,
      prompt: buildPlanPrompt(task, err.message, planText),
    };
    const [retryResult] = await spawnAll([retrySpec], { adapter, runHandle: run });
    if (retryResult.status !== "ok") {
      await run.patchManifest({ status: "error" });
      await session.log(
        `ghcp-maestro/${runId}: plan retry ${retryResult.status}: ${retryResult.error ?? "(no error)"}`,
        { level: "error" },
      );
      return run;
    }
    try {
      specs = parseAndValidatePlan((retryResult.output?.text ?? "").trim());
    } catch (err2) {
      await run.patchManifest({ status: "error" });
      await session.log(`ghcp-maestro/${runId}: plan retry also unparseable: ${err2.message}`, {
        level: "error",
      });
      return run;
    }
  }

  await session.log(
    `ghcp-maestro/${runId}: plan produced ${specs.length} subtask(s): ${specs.map((s) => s.agent).join(", ")}`,
  );

  // Phase 2 — explore: fan out the planned specs.
  await session.log(`ghcp-maestro/${runId}: phase=explore agents=${specs.length} (parallel)`);
  const exploreSpecs = specs.map((s, i) => ({
    id: `explore-${i}-${sanitizeAgentName(s.agent)}`,
    agent: s.agent,
    prompt: s.prompt,
    timeoutMs: 120_000,
  }));
  const t1 = Date.now();
  const exploreResults = await spawnAll(exploreSpecs, { adapter, runHandle: run });
  const phase1Elapsed = Date.now() - t1;
  for (const r of exploreResults) {
    const text = (r.output?.text ?? "").trim();
    const firstLine = text.split("\n")[0] ?? "";
    await session.log(
      `ghcp-maestro/${runId}: explore/${r.spec.agent} status=${r.status}${r.cached ? " (cached)" : ""} took=${r.finishedAt - r.startedAt}ms chars=${text.length} preview=${JSON.stringify(firstLine.slice(0, 100))}`,
    );
  }
  await session.log(
    `ghcp-maestro/${runId}: phase=explore wall-clock=${phase1Elapsed}ms (parallel of ${specs.length})`,
  );

  // Optional: dump the full per-subtask outputs into the session log so the
  // human can inspect them alongside the final synth.
  for (const r of exploreResults) {
    await session.log(
      `ghcp-maestro/${runId}: explore/${r.spec.agent} FULL ↓\n${(r.output?.text ?? "(empty)").trim()}`,
    );
  }

  // Phase 3 — synth: merge into a single answer to the original task.
  await session.log(`ghcp-maestro/${runId}: phase=synth agents=1`);
  const digest = exploreResults
    .map((r) => `## ${r.spec.agent}\n${(r.output?.text ?? "").trim() || "(no output)"}`)
    .join("\n\n");
  const synthSpec = {
    id: "synth",
    agent: "synth",
    timeoutMs: 120_000,
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
  const [synth] = await spawnAll([synthSpec], { adapter, runHandle: run });
  const phase2Elapsed = Date.now() - t2;
  await session.log(
    `ghcp-maestro/${runId}: synth status=${synth.status}${synth.cached ? " (cached)" : ""} took=${synth.finishedAt - synth.startedAt}ms wall=${phase2Elapsed}ms`,
  );
  await session.log(
    `ghcp-maestro/${runId}: FINAL ANSWER ↓\n${(synth.output?.text ?? "(empty)").trim()}`,
  );

  await run.complete();
  await session.log(
    `ghcp-maestro/${runId}: task workflow complete — ${1 + exploreResults.length + 1} agents across 3 phases (plan + explore[${specs.length}] + synth)`,
  );
  return run;
}

function buildPlanPrompt(task, parserError, previousReply) {
  const lines = [
    "You are a planning agent for a dynamic multi-agent workflow runtime.",
    "Decompose the following task into 3 to 6 INDEPENDENT subtasks that can run in parallel without seeing each other's output.",
    "Each subtask runs in its own isolated Copilot session — there is no shared state, no chat history, no working directory you can rely on. Subtasks must therefore be self-contained: include any context they need inside the prompt itself.",
    "",
    "Reply with ONLY a JSON array. No prose, no markdown fences, no commentary. Schema:",
    '[ { "agent": "<short kebab-case id, unique>", "prompt": "<self-contained instruction>" }, ... ]',
    "",
    'Rules:',
    "- 3 <= length <= 6",
    "- Every entry MUST have non-empty string `agent` and `prompt`",
    "- `agent` values MUST be unique within the array",
    "- Each `prompt` should produce a focused, finite answer in 1-2 short paragraphs or a small list. No open-ended exploration.",
    "- Cover the task from genuinely different angles; do not duplicate.",
    "",
    `Task: ${task}`,
  ];
  if (parserError) {
    lines.push(
      "",
      "Your previous reply could not be parsed. Parser error:",
      parserError,
      "",
      "Previous reply (for reference, do NOT repeat the same mistake):",
      previousReply ? previousReply.slice(0, 800) : "(empty)",
      "",
      "Return only the corrected JSON array, nothing else.",
    );
  }
  return lines.join("\n");
}

function parseAndValidatePlan(text) {
  if (!text) throw new Error("empty plan response");
  let body = text.trim();

  // Strip optional markdown fence wrappers — both multi-line and single-line.
  // 1) ```json\n …\n ```        (block fence)
  const blockFence = body.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?\s*```$/i);
  if (blockFence) {
    body = blockFence[1].trim();
  } else {
    // 2) ``` … ```  (single-line fence)
    const inlineFence = body.match(/^```(?:json|jsonc)?\s*([\s\S]*?)\s*```$/i);
    if (inlineFence) body = inlineFence[1].trim();
  }

  // Locate the outermost JSON array.
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `response does not contain a JSON array: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
    );
  }
  let jsonText = body.slice(start, end + 1);
  // Tolerate trailing commas — common LLM mistake (`{"a":1,}` or `[1,2,]`).
  // Only strips commas immediately before `]` / `}` so we don't mutilate valid JSON.
  jsonText = jsonText.replace(/,(\s*[}\]])/g, "$1");

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JSON.parse failed: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("plan must be an array");
  if (parsed.length < 3 || parsed.length > 6) {
    throw new Error(`plan must have 3-6 entries, got ${parsed.length}`);
  }
  const seen = new Set();
  const normalized = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`entry ${i} is not an object`);
    }
    if (typeof entry.agent !== "string" || entry.agent.trim() === "") {
      throw new Error(`entry ${i} missing string "agent"`);
    }
    if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") {
      throw new Error(`entry ${i} missing string "prompt"`);
    }
    const agent = entry.agent.trim();
    if (agent.length > 60) {
      throw new Error(`entry ${i} agent name too long (max 60 chars): ${agent.slice(0, 80)}…`);
    }
    if (seen.has(agent)) throw new Error(`duplicate agent name: ${agent}`);
    seen.add(agent);

    const prompt = entry.prompt.trim();
    if (prompt.length > 4_000) {
      throw new Error(
        `entry ${i} (${agent}) prompt is ${prompt.length} chars — must be <= 4000 to keep child-session prompts focused`,
      );
    }
    normalized.push({ agent, prompt });
  }
  return normalized;
}

function sanitizeAgentName(name) {
  return name.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 40) || "agent";
}
