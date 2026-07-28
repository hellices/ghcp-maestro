import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adversarialReview,
  multiAngle,
  fixLoop,
  crossCheck,
} from "../core/quality.mjs";

// A scripted adapter: `fn(spec)` returns the reply text (or throws to simulate
// an agent failure). Deterministic — no real model involved.
function scripted(fn) {
  return {
    name: "scripted",
    async invoke(spec) {
      const out = fn(spec);
      if (out instanceof Error) throw out;
      return { text: out };
    },
  };
}

// ── adversarialReview ──────────────────────────────────────────────────────

test("adversarialReview keeps findings that survive the majority of reviewers", async () => {
  const adapter = scripted((spec) =>
    spec.prompt.includes("Claim: solid")
      ? "VERDICT: VALID it holds"
      : "VERDICT: INVALID refuted",
  );
  const { survivors, rejected, reviewed } = await adversarialReview(
    [
      { id: "good", text: "solid" },
      { id: "bad", text: "weak" },
    ],
    { adapter, reviewers: 3 },
  );
  assert.equal(reviewed.length, 2);
  assert.deepEqual(survivors.map((s) => s.id), ["good"]);
  assert.deepEqual(rejected.map((s) => s.id), ["bad"]);
  assert.equal(survivors[0].score, 1);
});

test("adversarialReview respects the threshold", async () => {
  // 1 of 3 reviewers says valid → score 1/3.
  const adapter = scripted((spec) =>
    spec.id.endsWith("r0") ? "VERDICT: VALID" : "VERDICT: INVALID",
  );
  const lenient = await adversarialReview([{ id: "x", text: "t" }], {
    adapter,
    reviewers: 3,
    threshold: 0.3,
  });
  const strict = await adversarialReview([{ id: "x", text: "t" }], {
    adapter,
    reviewers: 3,
    threshold: 0.5,
  });
  assert.equal(lenient.survivors.length, 1);
  assert.equal(strict.survivors.length, 0);
});

test("adversarialReview treats agent failure as not-valid", async () => {
  const adapter = scripted(() => new Error("boom"));
  const { survivors, reviewed } = await adversarialReview(["claim"], {
    adapter,
    reviewers: 2,
  });
  assert.equal(survivors.length, 0);
  assert.equal(reviewed[0].votes.every((v) => v.valid === false), true);
});

test("adversarialReview returns empty for empty input", async () => {
  const adapter = scripted(() => "VALID");
  const res = await adversarialReview([], { adapter });
  assert.deepEqual(res, { survivors: [], rejected: [], reviewed: [] });
});

test("adversarialReview requires an adapter", async () => {
  await assert.rejects(() => adversarialReview(["x"], {}), /adapter is required/);
});

test("adversarialReview never cross-contaminates prefix-sharing ids (a vs a-r1)", async () => {
  // Reviewers for "alpha" all say VALID; reviewers for "beta" all say INVALID.
  // Under the old startsWith() grouping, item "a" would also absorb the
  // "a-r1" reviewer specs (review-a-r1-*) and lose its perfect score.
  const adapter = scripted((spec) =>
    spec.prompt.includes("Claim: alpha") ? "VERDICT: VALID" : "VERDICT: INVALID",
  );
  const { survivors, rejected, reviewed } = await adversarialReview(
    [
      { id: "a", text: "alpha" },
      { id: "a-r1", text: "beta" },
    ],
    { adapter, reviewers: 3 },
  );
  const a = reviewed.find((r) => r.id === "a");
  assert.equal(a.votes.length, 3); // exactly its own reviewers, not 6
  assert.equal(a.score, 1);
  assert.deepEqual(survivors.map((s) => s.id), ["a"]);
  assert.deepEqual(rejected.map((s) => s.id), ["a-r1"]);
});

// ── multiAngle ─────────────────────────────────────────────────────────────

test("multiAngle drafts each angle then applies the judge's choice", async () => {
  const adapter = scripted((spec) => {
    if (spec.id === "judge") return "CHOICE: 2\nfinal merged answer";
    return `draft for ${spec.agent}`;
  });
  const { drafts, choice, judge } = await multiAngle("write a function", {
    adapter,
    angles: ["a", "b", "c"],
  });
  assert.equal(drafts.length, 3);
  assert.equal(drafts[1].text, "draft for draft-b");
  assert.equal(choice.index, 1); // CHOICE: 2 → zero-based 1
  assert.match(judge.text, /final merged answer/);
});

test("multiAngle falls back to judge text when no CHOICE token", async () => {
  const adapter = scripted((spec) =>
    spec.id === "judge" ? "no explicit choice here" : "d",
  );
  const { choice } = await multiAngle("t", { adapter, angles: ["x", "y"] });
  assert.equal(choice.index, null);
  assert.equal(choice.text, "no explicit choice here");
});

test("multiAngle rejects an empty task", async () => {
  const adapter = scripted(() => "x");
  await assert.rejects(() => multiAngle("  ", { adapter }), /non-empty string/);
});

// ── fixLoop ────────────────────────────────────────────────────────────────

test("fixLoop stops as soon as check passes", async () => {
  let calls = 0;
  const fixes = [];
  const res = await fixLoop({
    adapter: scripted(() => "apply patch"),
    maxIters: 5,
    check: async (i) => {
      calls += 1;
      return { ok: i >= 2, report: `fail ${i}` };
    },
    applyFix: (r, i) => fixes.push(i),
  });
  assert.equal(res.ok, true);
  assert.equal(res.iterations, 3); // checks at i=0,1,2
  assert.equal(calls, 3);
  assert.deepEqual(fixes, [0, 1]); // fix dispatched after failed checks 0 and 1
});

test("fixLoop gives up after maxIters and reports failure", async () => {
  const res = await fixLoop({
    adapter: scripted(() => "patch"),
    maxIters: 3,
    check: async () => ({ ok: false, report: "still broken" }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.iterations, 3);
  assert.equal(res.history.length, 3);
});

test("fixLoop works without an adapter (applyFix only)", async () => {
  let repaired = 0;
  const res = await fixLoop({
    maxIters: 4,
    check: async (i) => ({ ok: i >= 1 }),
    applyFix: () => { repaired += 1; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.iterations, 2);
  assert.equal(repaired, 1);
});

test("fixLoop requires a check function", async () => {
  await assert.rejects(() => fixLoop({ maxIters: 2 }), /check must be a function/);
});

// ── crossCheck ─────────────────────────────────────────────────────────────

test("crossCheck aggregates support across sources", async () => {
  const adapter = scripted((spec) => {
    // The 'true' claim is supported by all sources; 'false' by none.
    if (spec.prompt.includes("Claim: true-claim")) return "SUPPORTED: YES";
    return "SUPPORTED: NO";
  });
  const { checked } = await crossCheck(
    [
      { id: "t", text: "true-claim" },
      { id: "f", text: "false-claim" },
    ],
    { adapter, sources: ["a", "b", "c"] },
  );
  assert.equal(checked.length, 2);
  assert.equal(checked[0].supportRate, 1);
  assert.equal(checked[1].supportRate, 0);
  assert.equal(checked[0].verdicts.length, 3);
});

test("crossCheck ignores undecided (failed) verdicts in the rate", async () => {
  // Source "a" is persistently down (fails every attempt, so the verdict stays
  // undecided even with spawn's auto-retry); retries: 0 keeps the test fast.
  const adapter = {
    name: "mixed",
    async invoke(spec) {
      if (spec.prompt.includes("perspective: a")) throw new Error("source down");
      return { text: "SUPPORTED: YES" };
    },
  };
  const { checked } = await crossCheck(["claim"], { adapter, sources: ["a", "b"], retries: 0 });
  // one verdict null (failed), one YES → rate 1/1 = 1
  assert.equal(checked[0].supportRate, 1);
  assert.equal(checked[0].verdicts.filter((v) => v.supported === null).length, 1);
});

test("crossCheck returns empty for empty claims", async () => {
  const adapter = scripted(() => "SUPPORTED: YES");
  const res = await crossCheck([], { adapter });
  assert.deepEqual(res, { checked: [] });
});

test("crossCheck reads NOT SUPPORTED / SUPPORTED: NO / UNSUPPORTED as unsupported", async () => {
  for (const reply of ["NOT SUPPORTED", "SUPPORTED: NO", "Unsupported, sorry"]) {
    const adapter = scripted(() => reply);
    const { checked } = await crossCheck(["claim"], { adapter, sources: ["a", "b"] });
    assert.equal(checked[0].supportRate, 0, `reply=${reply}`);
    assert.equal(
      checked[0].verdicts.every((v) => v.supported === false),
      true,
      `reply=${reply}`,
    );
  }
});

test("crossCheck still reads YES / bare SUPPORTED as supported", async () => {
  for (const reply of ["SUPPORTED: YES", "SUPPORTED"]) {
    const adapter = scripted(() => reply);
    const { checked } = await crossCheck(["claim"], { adapter, sources: ["a", "b"] });
    assert.equal(checked[0].supportRate, 1, `reply=${reply}`);
  }
});

test("crossCheck never cross-contaminates prefix-sharing ids", async () => {
  // "alpha" supported by all sources; "beta" by none. Old prefix grouping would
  // let item "c" absorb item "c-x" results and dilute its support rate.
  const adapter = scripted((spec) =>
    spec.prompt.includes("Claim: alpha") ? "SUPPORTED: YES" : "SUPPORTED: NO",
  );
  const { checked } = await crossCheck(
    [
      { id: "c", text: "alpha" },
      { id: "c-x", text: "beta" },
    ],
    { adapter, sources: ["s1", "s2"] },
  );
  const c = checked.find((x) => x.id === "c");
  const cx = checked.find((x) => x.id === "c-x");
  assert.equal(c.verdicts.length, 2); // only its own two sources
  assert.equal(c.supportRate, 1);
  assert.equal(cx.supportRate, 0);
  assert.deepEqual(c.verdicts.map((v) => v.source), ["s1", "s2"]);
});

test("crossCheck keeps sources distinct even when they slugify identically (R6)", async () => {
  // "first principles" and "first-principles" both slugify to "first-principles".
  // Without a per-source index in the spec id the two specs collide: both
  // verdicts would be mislabeled with the last source (and one source is lost).
  const adapter = scripted(() => "SUPPORTED: YES");
  const { checked } = await crossCheck(["claim"], {
    adapter,
    sources: ["first principles", "first-principles"],
  });
  assert.equal(checked[0].verdicts.length, 2);
  assert.deepEqual(
    checked[0].verdicts.map((v) => v.source),
    ["first principles", "first-principles"],
  );
  assert.equal(checked[0].supportRate, 1);
});
