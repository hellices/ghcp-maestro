import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../core/run-store.mjs";
import { resolveTargetRunId, readRunFrame } from "../core/tui-data.mjs";
import { mapKeyInput } from "../core/tui.mjs";

async function freshBase() {
  return mkdtemp(join(tmpdir(), "ghcp-maestro-tui-"));
}

test("resolveTargetRunId prefers the newest running run, else the newest run", async () => {
  const baseDir = await freshBase();
  try {
    assert.equal(await resolveTargetRunId({ baseDir }), undefined);

    const done = await createRun({ workflow: "old", baseDir });
    await done.complete();
    await new Promise((r) => setTimeout(r, 5));
    const active = await createRun({ workflow: "live", baseDir });
    await new Promise((r) => setTimeout(r, 5));
    const newerDone = await createRun({ workflow: "newer-done", baseDir });
    await newerDone.complete();

    assert.equal(await resolveTargetRunId({ baseDir }), active.runId, "running beats newer terminal runs");

    await active.complete();
    assert.equal(await resolveTargetRunId({ baseDir }), newerDone.runId, "falls back to newest overall");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readRunFrame returns manifest, snapshot and events for expanded agents only", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    await run.writeProgress({
      label: "x",
      done: 0,
      total: 2,
      maxElapsedMs: 100,
      totalTokens: 5,
      agents: [
        { specId: "a1", agent: "researcher", state: "tool", elapsedMs: 100, bytes: 0, tokens: 5, tool: "grep" },
        { specId: "a2", agent: "writer", state: "pending", elapsedMs: 0, bytes: 0, tokens: 0 },
      ],
    });
    await run.appendAgentEvent("a1", { phase: "explore", state: "tool", tool: "grep" });
    await run.appendAgentEvent("a2", { phase: "explore", state: "streaming", bytes: 7 });

    const frame = await readRunFrame(run.runId, { baseDir, expandedAgentIds: ["a1"] });
    assert.equal(frame.manifest.workflow, "task");
    assert.equal(frame.snapshot.total, 2);
    assert.equal(frame.events.a1.length, 1);
    assert.equal(frame.events.a1[0].tool, "grep");
    assert.equal(frame.events.a2, undefined, "collapsed agents are not tailed");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readRunFrame tolerates a run with no progress yet and unknown run ids", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    const frame = await readRunFrame(run.runId, { baseDir, expandedAgentIds: [] });
    assert.equal(frame.manifest.runId, run.runId);
    assert.equal(frame.snapshot, undefined);

    const missing = await readRunFrame("run-nope", { baseDir, expandedAgentIds: [] });
    assert.equal(missing, undefined);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("mapKeyInput maps terminal bytes to semantic keys", () => {
  assert.equal(mapKeyInput("\u001b[A"), "up");
  assert.equal(mapKeyInput("k"), "up");
  assert.equal(mapKeyInput("\u001b[B"), "down");
  assert.equal(mapKeyInput("j"), "down");
  assert.equal(mapKeyInput("\u001b[C"), "expand");
  assert.equal(mapKeyInput("\r"), "expand");
  assert.equal(mapKeyInput("\u001b[D"), "collapse");
  assert.equal(mapKeyInput("a"), "expandAll");
  assert.equal(mapKeyInput("q"), "quit");
  assert.equal(mapKeyInput("\u0003"), "quit"); // Ctrl-C
  assert.equal(mapKeyInput("z"), undefined);
});
