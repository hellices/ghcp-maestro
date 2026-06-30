import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exploreResultLine,
  wallClockLine,
  fanoutFailureSummary,
  allFailed,
  agentDigest,
  exploreFullDumpLine,
  logExploreResults,
} from "../extensions/ghcp-maestro/runtime/workflow-log.mjs";

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
  assert.equal(
    wallClockLine("run1", 6805, 3),
    "ghcp-maestro/run1: phase=explore wall-clock=6805ms (parallel of 3)",
  );
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
  assert.equal(line, "ghcp-maestro/run1: explore/tech FULL ↓\nfull body");
});

test("exploreFullDumpLine falls back to (empty) only for null/undefined output", () => {
  const missing = exploreFullDumpLine("run1", { spec: { agent: "tech" }, output: {} });
  assert.equal(missing, "ghcp-maestro/run1: explore/tech FULL ↓\n(empty)");
  // An explicit empty string stays empty (matches the pre-refactor behaviour).
  const blank = exploreFullDumpLine("run1", res("tech", "ok", ""));
  assert.equal(blank, "ghcp-maestro/run1: explore/tech FULL ↓\n");
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
