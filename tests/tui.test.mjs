import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTuiState,
  reduceKey,
  renderTui,
  renderRunsOverview,
} from "../core/tui.mjs";

const SNAP = {
  label: "ghcp-maestro/run-1 explore",
  done: 1,
  total: 3,
  maxElapsedMs: 65_000,
  totalTokens: 1500,
  agents: [
    { specId: "a1", agent: "researcher", state: "done", elapsedMs: 60_000, bytes: 4096, tokens: 900 },
    { specId: "a2", agent: "critic", state: "tool", elapsedMs: 30_000, bytes: 0, tokens: 600, tool: "grep" },
    { specId: "a3", agent: "writer", state: "pending", elapsedMs: 0, bytes: 0, tokens: 0 },
  ],
};

const MANIFEST = {
  runId: "run-1",
  workflow: "task",
  status: "running",
  startedAt: 1000,
  finishedAt: null,
  tokensUsed: 1500,
};

test("reduceKey moves selection and clamps to bounds", () => {
  let s = initialTuiState();
  assert.equal(s.selected, 0);
  s = reduceKey(s, "down", 3);
  assert.equal(s.selected, 1);
  s = reduceKey(s, "down", 3);
  s = reduceKey(s, "down", 3);
  assert.equal(s.selected, 2, "clamped at last row");
  s = reduceKey(s, "up", 3);
  assert.equal(s.selected, 1);
  s = reduceKey(s, "up", 3);
  s = reduceKey(s, "up", 3);
  assert.equal(s.selected, 0, "clamped at first row");
});

test("reduceKey expands/collapses the selected agent and expand-all toggles", () => {
  let s = initialTuiState();
  s = reduceKey(s, "down", 3); // select index 1
  s = reduceKey(s, "expand", 3);
  assert.deepEqual([...s.expanded], [1]);
  s = reduceKey(s, "collapse", 3);
  assert.deepEqual([...s.expanded], []);
  s = reduceKey(s, "expandAll", 3);
  assert.deepEqual([...s.expanded].sort(), [0, 1, 2]);
  s = reduceKey(s, "expandAll", 3); // toggles back
  assert.deepEqual([...s.expanded], []);
});

test("reduceKey quit flips the done flag; unknown keys are no-ops", () => {
  let s = initialTuiState();
  const before = s;
  s = reduceKey(s, "wat", 3);
  assert.deepEqual(s, before);
  s = reduceKey(s, "quit", 3);
  assert.equal(s.quit, true);
});

test("renderTui shows header, per-agent rows with selection marker", () => {
  const state = initialTuiState();
  const lines = renderTui({ snapshot: SNAP, manifest: MANIFEST, state, events: {}, width: 80 });
  const text = lines.join("\n");
  assert.match(text, /run-1/);
  assert.match(text, /task/);
  assert.match(text, /running/);
  assert.match(text, /1\/3 done/);
  assert.match(text, /1\.5K tok/);
  assert.match(text, /✓ .*researcher/);
  assert.match(text, /⠿ .*critic.*grep/);
  assert.match(text, /· .*writer.*pending/);
  // selection marker on the first row only
  const researcherLine = lines.find((l) => l.includes("researcher"));
  const criticLine = lines.find((l) => l.includes("critic"));
  assert.match(researcherLine, /^❯/);
  assert.doesNotMatch(criticLine, /^❯/);
  // keybinding hints in the footer
  assert.match(text, /q quit/);
});

test("renderTui expanded row shows the agent's recent event lines", () => {
  let state = initialTuiState();
  state = reduceKey(state, "down", 3);
  state = reduceKey(state, "expand", 3);
  const events = {
    a2: [
      { ts: 1000, phase: "explore", state: "tool", tool: "read_file" },
      { ts: 2000, phase: "explore", state: "streaming", bytes: 2048 },
    ],
  };
  const lines = renderTui({ snapshot: SNAP, manifest: MANIFEST, state, events, width: 80 });
  const text = lines.join("\n");
  assert.match(text, /read_file/);
  assert.match(text, /2\.0KB/);
  // collapsed agents show no event lines
  assert.doesNotMatch(text, /a1.*ndjson/);
});

test("renderTui shows a final summary for terminal runs", () => {
  const lines = renderTui({
    snapshot: { ...SNAP, done: 3 },
    manifest: { ...MANIFEST, status: "complete", finishedAt: 61_000 },
    state: initialTuiState(),
    events: {},
    width: 80,
  });
  assert.match(lines.join("\n"), /complete/);
});

test("renderRunsOverview renders one row per run manifest", () => {
  const lines = renderRunsOverview([
    MANIFEST,
    { runId: "run-0", workflow: "deep-review", status: "complete", startedAt: 500, finishedAt: 900, tokensUsed: 42 },
  ]);
  const text = lines.join("\n");
  assert.match(text, /run-1.*task.*running/);
  assert.match(text, /run-0.*deep-review.*complete/);
});
