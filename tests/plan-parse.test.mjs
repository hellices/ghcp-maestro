import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// parseAndValidatePlan is module-internal — re-extract via dynamic require of
// the extension module would also load joinSession() (and crash without
// SESSION_ID). Easiest reliable approach is to copy the function under test
// here. We assert the function in extension.mjs has the same source by
// extracting it textually so the copy doesn't silently drift.

async function loadParseFn() {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(
    join(here, "..", "extensions", "ghcp-maestro", "extension.mjs"),
    "utf8",
  );
  const match = src.match(/function parseAndValidatePlan\([\s\S]+?\n\}\n/);
  if (!match) throw new Error("could not locate parseAndValidatePlan in extension.mjs");
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}\nreturn parseAndValidatePlan;`)();
}

const parse = await loadParseFn();

const VALID = JSON.stringify([
  { agent: "a", prompt: "do a" },
  { agent: "b", prompt: "do b" },
  { agent: "c", prompt: "do c" },
]);

test("parseAndValidatePlan accepts a clean JSON array", () => {
  const out = parse(VALID);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((e) => e.agent),
    ["a", "b", "c"],
  );
});

test("parseAndValidatePlan strips multi-line ```json fences", () => {
  const wrapped = "```json\n" + VALID + "\n```";
  const out = parse(wrapped);
  assert.equal(out.length, 3);
});

test("parseAndValidatePlan strips single-line fences", () => {
  const wrapped = "```" + VALID + "```";
  const out = parse(wrapped);
  assert.equal(out.length, 3);
});

test("parseAndValidatePlan tolerates trailing commas", () => {
  const messy = '[\n{"agent":"a","prompt":"x"},\n{"agent":"b","prompt":"y"},\n{"agent":"c","prompt":"z"},\n]';
  const out = parse(messy);
  assert.equal(out.length, 3);
});

test("parseAndValidatePlan finds array embedded in chatter", () => {
  const noisy = "Sure, here's the plan:\n" + VALID + "\nLet me know!";
  const out = parse(noisy);
  assert.equal(out.length, 3);
});

test("parseAndValidatePlan rejects empty and non-array", () => {
  assert.throws(() => parse(""), /empty plan/);
  assert.throws(() => parse("{}"), /JSON array/);
  assert.throws(() => parse('"hi"'), /JSON array/);
});

test("parseAndValidatePlan enforces 3-6 entries", () => {
  const tooFew = JSON.stringify([
    { agent: "a", prompt: "p" },
    { agent: "b", prompt: "p" },
  ]);
  const tooMany = JSON.stringify(
    Array.from({ length: 7 }, (_, i) => ({ agent: `a${i}`, prompt: "p" })),
  );
  assert.throws(() => parse(tooFew), /3-6 entries/);
  assert.throws(() => parse(tooMany), /3-6 entries/);
});

test("parseAndValidatePlan rejects duplicate agent names", () => {
  const dupe = JSON.stringify([
    { agent: "x", prompt: "1" },
    { agent: "x", prompt: "2" },
    { agent: "y", prompt: "3" },
  ]);
  assert.throws(() => parse(dupe), /duplicate agent/);
});

test("parseAndValidatePlan rejects missing fields", () => {
  const bad1 = JSON.stringify([
    { prompt: "p" },
    { agent: "b", prompt: "p" },
    { agent: "c", prompt: "p" },
  ]);
  const bad2 = JSON.stringify([
    { agent: "a", prompt: "" },
    { agent: "b", prompt: "p" },
    { agent: "c", prompt: "p" },
  ]);
  assert.throws(() => parse(bad1), /missing string "agent"/);
  assert.throws(() => parse(bad2), /missing string "prompt"/);
});

test("parseAndValidatePlan rejects oversized prompt", () => {
  const huge = "x".repeat(4_001);
  const oversized = JSON.stringify([
    { agent: "a", prompt: huge },
    { agent: "b", prompt: "p" },
    { agent: "c", prompt: "p" },
  ]);
  assert.throws(() => parse(oversized), /must be <= 4000/);
});

test("parseAndValidatePlan rejects oversized agent name", () => {
  const longName = "a".repeat(61);
  const bad = JSON.stringify([
    { agent: longName, prompt: "p" },
    { agent: "b", prompt: "p" },
    { agent: "c", prompt: "p" },
  ]);
  assert.throws(() => parse(bad), /agent name too long/);
});
