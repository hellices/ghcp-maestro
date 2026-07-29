import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSynthPrompt } from "../core/synth.mjs";

test("buildSynthPrompt embeds the task and a per-agent digest", () => {
  const prompt = buildSynthPrompt({
    task: "Ship the feature",
    results: [
      { spec: { agent: "alpha" }, output: { text: "did A" } },
      { spec: { agent: "bravo" }, output: { text: "did B" } },
    ],
  });
  assert.match(prompt, /Original task: Ship the feature/);
  assert.match(prompt, /## alpha\ndid A/);
  assert.match(prompt, /## bravo\ndid B/);
  assert.match(prompt, /Subagent outputs:/);
  assert.match(prompt, /synthesis agent/);
});

test("buildSynthPrompt renders empty agent output as (no output)", () => {
  const prompt = buildSynthPrompt({
    task: "T",
    results: [{ spec: { agent: "solo" }, output: { text: "" } }],
  });
  assert.match(prompt, /## solo\n\(no output\)/);
});

test("buildSynthPrompt matches the canonical task-workflow prompt byte-for-byte", () => {
  // Guards the CLI task workflow against accidental prompt drift once the
  // inline prompt is replaced by this shared builder.
  const prompt = buildSynthPrompt({
    task: "X",
    results: [{ spec: { agent: "a" }, output: { text: "o" } }],
  });
  const expected = [
    "You are a synthesis agent. Several independent subagents tackled different parts of a single task.",
    "Merge their outputs into a coherent final answer to the original task.",
    "Be concrete, deduplicate, surface disagreements, and end with a short 'next actions' list of at most 5 items.",
    "",
    "Original task: X",
    "",
    "Subagent outputs:",
    "## a\no",
  ].join("\n");
  assert.equal(prompt, expected);
});

// --- Partial-failure disclosure (#22) ----------------------------------------

test("buildSynthPrompt discloses failed subagents and instructs about missing angles", () => {
  const prompt = buildSynthPrompt({
    task: "T",
    results: [
      { spec: { agent: "a" }, status: "ok", output: { text: "o" } },
      { spec: { agent: "b" }, status: "timeout", error: "agent timed out after 5ms" },
    ],
  });
  assert.match(prompt, /## a\no/);
  assert.match(prompt, /## b \(FAILED: timeout\)/);
  assert.match(prompt, /state explicitly which angles are missing/);
});

test("buildSynthPrompt omits the missing-angles instruction when every subagent succeeded", () => {
  const prompt = buildSynthPrompt({
    task: "T",
    results: [{ spec: { agent: "a" }, status: "ok", output: { text: "o" } }],
  });
  assert.doesNotMatch(prompt, /missing/);
});
