import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exploreResultLine,
  wallClockLine,
  fanoutFailureSummary,
  allFailed,
  agentDigest,
  coverageLine,
  exploreFullDumpLine,
  logExploreResults,
  labeledDumpLine,
  synthStatusLine,
  MAX_AGENT_OUTPUT_CHARS,
  MAX_AGENT_DIGEST_CHARS,
} from "../core/workflow-log.mjs";

// A minimal AgentResult-like shape, matching what spawnAll returns.
function res(agent, status, text, { cached = false, startedAt = 0, finishedAt = 100 } = {}) {
  return { spec: { agent }, status, cached, startedAt, finishedAt, output: { text } };
}

test("exploreResultLine renders the brainstorm/task 'preview' variant", () => {
  const r = res("tech", "ok", "first line\nsecond line", { startedAt: 0, finishedAt: 1500 });
  const line = exploreResultLine("run1", r, { mode: "preview" });
  assert.match(line, /^ghcp-maestro\/run1: explore\/tech /);
  assert.match(line, /status=ok/);
  assert.match(line, /took=1500ms/);
  assert.match(line, /chars=22/); // length of "first line\nsecond line"
  assert.match(line, /preview="first line"/); // first line only, JSON-quoted
});

test("exploreResultLine renders the hello 'reply' variant", () => {
  const r = res("explore-a", "ok", "ALPHA", { startedAt: 0, finishedAt: 600 });
  const line = exploreResultLine("run1", r, { mode: "reply" });
  assert.match(line, /explore\/explore-a/);
  assert.match(line, /took=600ms/);
  assert.match(line, /reply="ALPHA"/);
  assert.doesNotMatch(line, /chars=/);
});

test("exploreResultLine marks cached results", () => {
  const r = res("tech", "ok", "x", { cached: true });
  assert.match(exploreResultLine("run1", r, { mode: "preview" }), /\(cached\)/);
});

test("exploreResultLine truncates preview to 100 chars and reply to 40", () => {
  const long = "a".repeat(300);
  const preview = exploreResultLine("r", res("z", "ok", long), { mode: "preview" });
  // preview slice is 100 chars inside the JSON string
  assert.match(preview, /preview="a{100}"/);
  const reply = exploreResultLine("r", res("z", "ok", long), { mode: "reply" });
  assert.match(reply, /reply="a{40}"/);
});

test("wallClockLine reports the parallel phase wall-clock", () => {
  const line = wallClockLine("run1", 6805, 3);
  assert.match(line, /^ghcp-maestro\/run1: /);
  assert.match(line, /wall-clock=6805ms/);
  assert.match(line, /parallel of 3/);
});

test("fanoutFailureSummary lists failed agents with their status", () => {
  const results = [res("a", "ok", "x"), res("b", "timeout", ""), res("c", "error", "")];
  const summary = fanoutFailureSummary("run1", results, "explore");
  assert.match(summary, /2\/3 explore agent\(s\) failed/);
  assert.match(summary, /b=timeout/);
  assert.match(summary, /c=error/);
});

test("fanoutFailureSummary returns null when nothing failed", () => {
  const results = [res("a", "ok", "x"), res("b", "ok", "y")];
  assert.equal(fanoutFailureSummary("run1", results, "explore"), null);
});

test("allFailed is true only when every result is non-ok", () => {
  assert.equal(allFailed([res("a", "error", ""), res("b", "timeout", "")]), true);
  assert.equal(allFailed([res("a", "ok", "x"), res("b", "error", "")]), false);
  assert.equal(allFailed([]), false);
});

// agentDigest keeps exact-equality assertions on purpose: its output is fed
// verbatim into the synth prompt, so the byte shape is a contract (what the
// LLM sees + resume/cache determinism), not a cosmetic log line.
test("agentDigest joins per-agent outputs under '## agent' headers", () => {
  const results = [res("tech", "ok", "  point A  "), res("ux", "ok", "point B")];
  const digest = agentDigest(results);
  assert.equal(digest, "## tech\npoint A\n\n## ux\npoint B");
});

test("agentDigest uses a placeholder for empty output", () => {
  const digest = agentDigest([res("tech", "ok", "")], { emptyPlaceholder: "(no output)" });
  assert.equal(digest, "## tech\n(no output)");
});

test("exploreFullDumpLine dumps the trimmed full output under a FULL header", () => {
  const line = exploreFullDumpLine("run1", res("tech", "ok", "  full body  "));
  assert.match(line, /run1.*explore\/tech.*FULL/);
  assert.match(line, /\nfull body$/); // trimmed, dumped verbatim after the header
});

test("exploreFullDumpLine falls back to (empty) only for null/undefined output", () => {
  const missing = exploreFullDumpLine("run1", { spec: { agent: "tech" }, output: {} });
  assert.match(missing, /\n\(empty\)$/);
  // An explicit empty string stays empty (matches the pre-refactor behaviour).
  const blank = exploreFullDumpLine("run1", res("tech", "ok", ""));
  assert.match(blank, /\n$/);
  assert.doesNotMatch(blank, /\(empty\)/);
});

test("logExploreResults emits preview, wall-clock and FULL dump in order (no failures)", async () => {
  const results = [res("a", "ok", "one"), res("b", "ok", "two")];
  const calls = [];
  await logExploreResults({
    runId: "run1",
    results,
    elapsedMs: 1200,
    count: 2,
    label: "explore",
    log: (msg, opts) => calls.push([msg, opts]),
  });
  assert.equal(calls.length, 5); // 2 previews + wall-clock + 2 FULL dumps
  assert.match(calls[0][0], /explore\/a status=ok/);
  assert.match(calls[1][0], /explore\/b status=ok/);
  assert.equal(calls[2][0], wallClockLine("run1", 1200, 2));
  assert.match(calls[3][0], /explore\/a FULL ↓\none/);
  assert.match(calls[4][0], /explore\/b FULL ↓\ntwo/);
  for (const [, opts] of calls) assert.equal(opts, undefined);
});

test("logExploreResults appends a warning-level failure summary when some agents fail", async () => {
  const results = [res("a", "ok", "one"), res("b", "timeout", "")];
  const calls = [];
  await logExploreResults({
    runId: "run1",
    results,
    elapsedMs: 50,
    count: 2,
    label: "subtask",
    log: (msg, opts) => calls.push([msg, opts]),
  });
  const last = calls.at(-1);
  assert.match(last[0], /1\/2 subtask agent\(s\) failed/);
  assert.deepEqual(last[1], { level: "warning" });
});

test("labeledDumpLine dumps trimmed output under a custom label header", () => {
  const answer = labeledDumpLine("run1", "FINAL ANSWER", res("synth", "ok", "  the answer  "));
  assert.match(answer, /run1.*FINAL ANSWER/);
  assert.match(answer, /\nthe answer$/);
  const steps = labeledDumpLine("run1", "TOP 3 NEXT STEPS", res("synth", "ok", "a\nb\nc"));
  assert.match(steps, /TOP 3 NEXT STEPS/);
  assert.match(steps, /\na\nb\nc$/);
});

test("labeledDumpLine falls back to (empty) only for missing output", () => {
  const line = labeledDumpLine("run1", "FINAL ANSWER", { spec: { agent: "synth" }, output: {} });
  assert.match(line, /\n\(empty\)$/);
});

test("synthStatusLine renders the brainstorm variant (no wall)", () => {
  const r = res("synth", "ok", "x", { startedAt: 0, finishedAt: 1500 });
  const line = synthStatusLine("run1", r);
  assert.match(line, /synth status=ok/);
  assert.match(line, /took=1500ms/);
  assert.doesNotMatch(line, /wall=/);
  assert.doesNotMatch(line, /\(cached\)/);
});

test("synthStatusLine renders the task variant (with wall) and cached tag", () => {
  const r = res("synth", "ok", "x", { startedAt: 0, finishedAt: 1500, cached: true });
  const line = synthStatusLine("run1", r, { wallMs: 200 });
  assert.match(line, /synth status=ok/);
  assert.match(line, /\(cached\)/);
  assert.match(line, /took=1500ms/);
  assert.match(line, /wall=200ms/);
});

// --- Partial-failure disclosure (#22) ----------------------------------------

test("agentDigest renders non-ok results as explicit FAILED blocks", () => {
  const digest = agentDigest(
    [
      { spec: { agent: "good" }, status: "ok", output: { text: "fine" } },
      { spec: { agent: "slow" }, status: "timeout", error: "agent timed out after 5ms" },
      { spec: { agent: "dep" }, status: "skipped", error: 'dependency "slow" did not complete' },
    ],
    { emptyPlaceholder: "(no output)" },
  );
  assert.match(digest, /## good\nfine/);
  assert.match(digest, /## slow \(FAILED: timeout\)\n\(this angle is missing — agent timed out after 5ms\)/);
  assert.match(digest, /## dep \(FAILED: skipped\)/);
});

test("agentDigest treats results without a status as ok (back-compat)", () => {
  const digest = agentDigest([{ spec: { agent: "a" }, output: { text: "o" } }]);
  assert.equal(digest, "## a\no");
});

// --- Bounded agent digest (final-review #2) ----------------------------------

test("agentDigest exports MAX constants for per-agent and total caps", () => {
  assert.equal(typeof MAX_AGENT_OUTPUT_CHARS, "number");
  assert.equal(MAX_AGENT_OUTPUT_CHARS, 4_000);
  assert.equal(typeof MAX_AGENT_DIGEST_CHARS, "number");
  assert.equal(MAX_AGENT_DIGEST_CHARS, 64_000);
});

test("agentDigest preserves byte-identical output for small runs", () => {
  const results = [res("tech", "ok", "  point A  "), res("ux", "ok", "point B")];
  assert.equal(agentDigest(results), "## tech\npoint A\n\n## ux\npoint B");
});

test("agentDigest truncates large outputs and stays within MAX_AGENT_DIGEST_CHARS", () => {
  const longOutput = "x".repeat(8_000);
  const results = Array.from({ length: 50 }, (_, i) =>
    res(`agent-${i}`, "ok", longOutput),
  );
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS, `digest length ${digest.length} exceeds cap ${MAX_AGENT_DIGEST_CHARS}`);
  // Every agent heading is preserved.
  for (let i = 0; i < 50; i++) {
    assert.ok(digest.includes(`## agent-${i}`), `missing heading for agent-${i}`);
  }
  // Truncated bodies carry the marker.
  assert.ok(digest.includes("…[truncated]"), "truncated entries should carry the marker");
});

test("agentDigest truncates failed-agent error text and keeps heading", () => {
  const longError = "E".repeat(8_000);
  const results = Array.from({ length: 50 }, (_, i) =>
    ({ spec: { agent: `err-${i}` }, status: "error", error: longError, startedAt: 0, finishedAt: 1 }),
  );
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS);
  for (let i = 0; i < 50; i++) {
    assert.ok(digest.includes(`## err-${i}`), `missing heading for err-${i}`);
  }
});

test("coverageLine summarises ok vs failed subtasks", () => {
  const mk = (agent, status) => ({ spec: { agent }, status });
  assert.equal(
    coverageLine("r1", [mk("a", "ok"), mk("b", "ok"), mk("c", "ok")]),
    "ghcp-maestro/r1: coverage: 3/3 subtasks ok",
  );
  assert.equal(
    coverageLine("r1", [mk("a", "error"), mk("b", "skipped"), mk("c", "ok"), mk("d", "timeout")]),
    "ghcp-maestro/r1: coverage: 1/4 subtasks ok (1 error, 1 skipped, 1 timeout)",
  );
});

// --- Per-agent digest cap (re-review #3) -------------------------------------

test("agentDigest caps one huge success output to MAX_AGENT_OUTPUT_CHARS including marker", () => {
  const hugeBody = "x".repeat(10_000);
  const digest = agentDigest([res("big", "ok", hugeBody)]);
  const bodyStart = digest.indexOf("\n") + 1;
  const body = digest.slice(bodyStart);
  assert.ok(body.length <= MAX_AGENT_OUTPUT_CHARS,
    `body length ${body.length} exceeds per-agent cap ${MAX_AGENT_OUTPUT_CHARS}`);
  assert.ok(body.endsWith("…[truncated]"), "capped body must carry truncation marker");
});

test("agentDigest caps failure reason to MAX_AGENT_OUTPUT_CHARS", () => {
  const hugeError = "E".repeat(10_000);
  const digest = agentDigest([{ spec: { agent: "fail" }, status: "error", error: hugeError, startedAt: 0, finishedAt: 1 }]);
  const headingEnd = digest.indexOf("\n") + 1;
  const body = digest.slice(headingEnd);
  assert.ok(body.length <= MAX_AGENT_OUTPUT_CHARS,
    `failure body ${body.length} exceeds per-agent cap ${MAX_AGENT_OUTPUT_CHARS}`);
});

test("agentDigest preserves 50 headings with per-agent cap and stays within total cap", () => {
  const results = Array.from({ length: 50 }, (_, i) =>
    res(`agent-${i}`, "ok", "x".repeat(8_000)),
  );
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS);
  for (let i = 0; i < 50; i++) {
    assert.ok(digest.includes(`## agent-${i}`), `missing heading for agent-${i}`);
  }
});

// --- Arbitrary large digest inputs (re-review #4) ----------------------------

test("agentDigest handles 1000 results with long names and long bodies", () => {
  const longName = "agent-" + "x".repeat(55);
  const longBody = "B".repeat(10_000);
  const results = Array.from({ length: 1000 }, (_, i) => ({
    spec: { agent: `${longName}-${i}` },
    status: "ok",
    output: { text: longBody },
    startedAt: 0,
    finishedAt: 1,
  }));
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS,
    `digest length ${digest.length} exceeds cap ${MAX_AGENT_DIGEST_CHARS}`);
  const headingCount = (digest.match(/^## /gm) || []).length;
  if (headingCount < 1000) {
    assert.ok(digest.includes("omitted"), "must disclose omitted agents");
  }
});

test("agentDigest stays within MAX_AGENT_DIGEST_CHARS with 1000 legal-length names (marker overflow)", () => {
  // 1000 entries with 48-55 char names: headings consume most of the 64 000
  // budget, leaving perEntry < MARKER.length — the marker itself must not
  // push the total over the cap.
  const results = Array.from({ length: 1000 }, (_, i) => {
    const nameLen = 48 + (i % 8);
    const name = `agent-${String(i).padStart(4, "0")}-${"x".repeat(nameLen - 11)}`;
    return {
      spec: { agent: name },
      status: "ok",
      output: { text: "x".repeat(100) },
      startedAt: 0,
      finishedAt: 1,
    };
  });
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS,
    `digest length ${digest.length} must not exceed ${MAX_AGENT_DIGEST_CHARS}`);
});

test("agentDigest stays within cap when perEntry floors to 0 (1000 × 58-char names, 1-char bodies)", () => {
  // Overhead: 1000 × 62 + 999 × 2 = 63 998; bodyBudget = 2.
  // perEntry must be 0 so the 1-char bodies are dropped; a floor of 1
  // would let all 1 000 bodies through → 64 998.
  const results = Array.from({ length: 1000 }, (_, i) => ({
    spec: { agent: `agent-${String(i).padStart(4, "0")}-${"x".repeat(47)}` },
    status: "ok",
    output: { text: "x" },
    startedAt: 0,
    finishedAt: 1,
  }));
  const digest = agentDigest(results);
  assert.ok(digest.length <= MAX_AGENT_DIGEST_CHARS,
    `digest length ${digest.length} must not exceed ${MAX_AGENT_DIGEST_CHARS}`);
});
