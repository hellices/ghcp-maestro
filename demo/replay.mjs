#!/usr/bin/env node
// Scripted replay of a `/maestro task` session, used to render the README
// demo GIF (see demo/demo.tape, rendered with charmbracelet/vhs).
//
// This is presentation-only: it prints log lines that closely mirror what the
// task workflow emits (core/builtin-workflows.mjs + core/workflow-log.mjs +
// core/monitor.mjs formats), so the GIF shows what a run looks like without
// needing a live Copilot session. It is not byte-identical to a real run:
// ANSI color is added for legibility, the full-output dump lines are omitted
// for brevity, and elapsed times are time-lapsed — a real run of this size
// takes a few minutes.
//
// Usage: node demo/replay.mjs        (DEMO_SPEED=3 for a 3x faster dry run)

const out = process.stdout;
const SPEED = Number(process.env.DEMO_SPEED) || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));

const ESC = "\u001b[";
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const cyan = (s) => `${ESC}36m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s) => `${ESC}33m${s}${ESC}0m`;
const magenta = (s) => `${ESC}35m${s}${ESC}0m`;

const RUN_ID = "run-mdl4k2ta-x9f3q1";
const PREFIX = dim(`ghcp-maestro/${RUN_ID}:`);

async function typeLine(text, msPerChar = 26) {
  out.write(bold(cyan("> ")));
  for (const ch of text) {
    out.write(ch);
    await sleep(msPerChar);
  }
  out.write("\n");
}

async function log(line, pauseMs = 350) {
  out.write(`${PREFIX} ${line}\n`);
  await sleep(pauseMs);
}

// --- live fan-out dashboard (core/monitor.mjs renderDashboard format) -------

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const ktok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function renderDashboard(agents, elapsedMs) {
  const done = agents.filter((a) => a.done).length;
  const total = agents.reduce((s, a) => s + a.tokens, 0);
  const head = dim(`explore · ${done}/${agents.length} done · ${mmss(elapsedMs)} · ${ktok(total)} tok`);
  const rows = agents.map((a) => {
    const glyph = a.done ? green("✓") : yellow("⠿");
    const state = a.done ? "done" : a.tool ? "tool" : "streaming";
    const secs = `${Math.round((a.done ? a.doneAt : elapsedMs) / 1000)}s`;
    const kb = `${(a.bytes / 1024).toFixed(1)}KB`;
    const tool = !a.done && a.tool ? `  ${dim(`(${a.tool})`)}` : "";
    return `  ${glyph} ${a.agent.padEnd(12)}  ${state.padEnd(9)}  ${secs.padStart(4)}  ${kb}${tool}  ${ktok(a.tokens)} tok`;
  });
  return [head, ...rows].join("\n");
}

async function liveFanOut() {
  // Displayed clock runs ~8x real time (time-lapse); frames every ~370ms real.
  const agents = [
    { agent: "performance", doneAt: 41_000, tokens: 0, bytes: 0, tool: null, done: false },
    { agent: "operations", doneAt: 47_000, tokens: 0, bytes: 0, tool: null, done: false },
    { agent: "cost", doneAt: 33_000, tokens: 0, bytes: 0, tool: null, done: false },
    { agent: "migration", doneAt: 48_000, tokens: 0, bytes: 0, tool: null, done: false },
  ];
  const tools = ["fetch_url", "read_file", null, "grep", null];
  const STEP = 3_000; // displayed ms per frame
  const lines = agents.length + 1;
  let first = true;
  for (let t = STEP; t <= 48_000; t += STEP) {
    for (const [i, a] of agents.entries()) {
      if (a.done) continue;
      if (t >= a.doneAt) {
        a.done = true;
        a.tool = null;
      } else {
        a.tokens += 380 + ((i * 131 + t) % 260);
        a.bytes += 900 + ((i * 977 + t) % 800);
        a.tool = tools[(i + t / STEP) % tools.length];
      }
    }
    if (!first) out.write(`${ESC}${lines}A`); // redraw in place
    first = false;
    out.write(`${ESC}0J${renderDashboard(agents, t)}\n`);
    await sleep(370);
  }
}

// --- the session ------------------------------------------------------------

const task = "Compare PostgreSQL, MySQL, and SQLite for a write-heavy multi-tenant SaaS";

out.write(`${ESC}2J${ESC}H`); // clear the launch command off the screen
await sleep(600);
await typeLine(`/maestro task ${task}`);
await sleep(500);

await log(`task "${task}" (adapter=copilot-cli, concurrency=16)`);
await log(`${cyan("phase=plan")} agents=1`, 200);
await sleep(1400);
await log(`plan took=8421ms chars=642`, 250);
await log(`plan produced ${bold("4 subtask(s)")}: performance, operations, cost, migration`, 300);
await log(`est. run size: medium (6 agents incl. plan+synth)`, 400);

// Plan approval gate (core/plan-approval.mjs)
await log(`plan ready: 4 subtask(s) — review before fan-out:`, 150);
for (const [agent, preview] of [
  ["performance", "Benchmark write-heavy OLTP throughput, contention behavior, and…"],
  ["operations", "Compare backup/replication/failover story and day-2 operational…"],
  ["cost", "Estimate infra + licensing + operational cost at 10/100/1000 ten…"],
  ["migration", "Assess migration effort and lock-in risk from a typical single-…"],
]) {
  await log(`  • ${bold(agent)}: ${dim(preview)}`, 200);
}
out.write(`\n${magenta("?")} Plan ready: 4 subtask(s). Select which to run, then Accept ${dim("(Decline to abort)")}\n`);
await sleep(1500);
out.write(`${green("✔")} approved 4/4 subtasks\n\n`);
await sleep(400);

// Fan-out with the live dashboard
await log(`${cyan("phase=explore")} agents=4 (parallel)`, 400);
await liveFanOut();
await sleep(300);
await log(`explore/performance status=${green("ok")} took=41007ms chars=15872 preview="PostgreSQL sustains ~38k mixed TPS…"`, 220);
await log(`explore/operations status=${green("ok")} took=46512ms chars=20991 preview="Managed PG and MySQL are even; SQL…"`, 220);
await log(`explore/cost status=${green("ok")} took=32988ms chars=13517 preview="SQLite wins only below ~10 tenants…"`, 220);
await log(`explore/migration status=${green("ok")} took=47701ms chars=19866 preview="Schema-per-tenant maps to PG parti…"`, 220);
await log(`phase=explore wall-clock=48210ms (parallel of 4)`, 500);

// Synthesis
await log(`${cyan("phase=synth")} agents=1`, 300);
await sleep(1600);
await log(`synth status=${green("ok")} took=12034ms wall=12034ms`, 200);
await log(`coverage: ${green("4/4 subtasks ok")}`, 300);
await log(`FINAL ANSWER ↓`, 150);
for (const line of [
  `  ${bold("Recommendation: PostgreSQL.")} It is the only option that holds up on all`,
  `  four cross-checked angles for a write-heavy multi-tenant SaaS:`,
  `    1. Writes — MVCC + native partitioning sustain contended writes; SQLite's`,
  `       single-writer lock disqualifies it beyond a handful of tenants.`,
  `    2. Tenancy — row-level security + schema-per-tenant beat MySQL workarounds.`,
  `    3. Cost — managed PG ≈ managed MySQL at 100+ tenants; ops maturity equal.`,
  `    4. Migration — the riskiest path is deferring the move; do it pre-scale.`,
]) {
  out.write(`${line}\n`);
  await sleep(160);
}
await sleep(500);
await log(
  `task workflow ${green("complete")} — 6 agents across 3 phases (plan + explore[4] + synth) tokens=48213`,
  400,
);
await sleep(2500);
