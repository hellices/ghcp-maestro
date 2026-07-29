// Quality patterns (M6) — multi-agent helpers built on top of spawnAll.
//
// Each helper turns a single logical question into several isolated subagent
// invocations and aggregates the replies. They are deliberately decoupled from
// any specific adapter: callers pass the adapter (standalone-client in
// production, dummy/custom in tests) plus optional prompt builders and verdict
// parsers, so the orchestration logic is unit-testable without a live model.
//
// All four follow the same contract:
//   - never throw on individual agent failure (the underlying spawnAll captures
//     per-agent status); failures are surfaced in the returned aggregate
//   - accept `{ adapter, concurrency, signal, runHandle }` forwarded to spawnAll
//   - accept `spawnAll` / `spawn` overrides for testing (default to the real ones)

import { spawn as defaultSpawn, spawnAll as defaultSpawnAll } from "./spawn.mjs";

function textOf(result) {
  const out = result?.output;
  if (out == null) return "";
  if (typeof out === "string") return out;
  if (typeof out.text === "string") return out.text;
  if (typeof out.echo === "string") return out.echo; // dummy adapter shape
  return "";
}

// ── adversarialReview ────────────────────────────────────────────────────────

/**
 * Independent reviewers try to rebut each finding. A finding "survives" when
 * at least `threshold` (fraction) of its reviewers judge it valid.
 *
 * @param {Array<string | { id?: string, text: string }>} findings
 * @param {{
 *   adapter: import("./spawn.mjs").SubagentAdapter,
 *   reviewers?: number,
 *   threshold?: number,
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   runHandle?: object,
 *   buildPrompt?: (finding: string, reviewerIndex: number, findingIndex: number) => string,
 *   parseVerdict?: (text: string) => { valid: boolean, reason?: string },
 *   spawnAll?: Function,
 * }} opts
 * @returns {Promise<{ survivors: Array<object>, rejected: Array<object>, reviewed: Array<object> }>}
 */
export async function adversarialReview(findings, opts) {
  requireAdapter(opts, "adversarialReview");
  if (!Array.isArray(findings) || findings.length === 0) {
    return { survivors: [], rejected: [], reviewed: [] };
  }
  const reviewers = clampPositiveInt(opts.reviewers, 3, "reviewers");
  const threshold = clampFraction(opts.threshold, 0.5, "threshold");
  const buildPrompt = opts.buildPrompt ?? defaultReviewPrompt;
  const parseVerdict = opts.parseVerdict ?? defaultVerdictParser;
  const spawnAll = opts.spawnAll ?? defaultSpawnAll;

  const items = findings.map((f, i) => normalizeFinding(f, i));
  // One spec per (finding, reviewer). The reviewer index `r` keeps spec ids
  // unique even when two findings normalize to the same slug; fanOutPerItem then
  // regroups results by exact spec id, never by string prefix.
  const reviewerIdxs = Array.from({ length: reviewers }, (_, r) => r);
  const grouped = await fanOutPerItem(items, reviewerIdxs, {
    specId: (item, _r, rIdx) => `review-${item.index}-${item.id}-r${rIdx}`,
    buildPrompt: (item, _r, rIdx) => buildPrompt(item.text, rIdx, item.index),
    forward: forwardOpts(opts),
    spawnAll,
  });

  const reviewed = grouped.map(({ item, owned }) => {
    const votes = owned.map(({ result: res }) => {
      if (res.status !== "ok") return { valid: false, reason: `reviewer ${res.status}` };
      return parseVerdict(textOf(res));
    });
    const validCount = votes.filter((v) => v.valid).length;
    const score = votes.length ? validCount / votes.length : 0;
    return { ...item, votes, score, survived: score >= threshold };
  });

  return {
    survivors: reviewed.filter((r) => r.survived),
    rejected: reviewed.filter((r) => !r.survived),
    reviewed,
  };
}

function defaultReviewPrompt(finding, _reviewerIndex, _findingIndex) {
  return [
    "You are an adversarial reviewer. Try hard to find a flaw in the claim below.",
    "If the claim survives your scrutiny, it is VALID. If you can refute it, it is INVALID.",
    "",
    `Claim: ${finding}`,
    "",
    'Reply on a single line starting with "VERDICT: VALID" or "VERDICT: INVALID", followed by one sentence of justification.',
  ].join("\n");
}

function defaultVerdictParser(text) {
  const t = String(text).toUpperCase();
  if (/\bINVALID\b/.test(t)) return { valid: false, reason: firstLine(text) };
  if (/\bVALID\b/.test(t)) return { valid: true, reason: firstLine(text) };
  // Unknown verdict — treat as not-validated to stay conservative.
  return { valid: false, reason: "unparseable verdict" };
}

// ── multiAngle ───────────────────────────────────────────────────────────────

/**
 * Draft the same task from several angles in parallel, then have a judge agent
 * pick or merge the best result.
 *
 * @param {string} task
 * @param {{
 *   adapter: import("./spawn.mjs").SubagentAdapter,
 *   angles?: string[],
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   runHandle?: object,
 *   buildDraftPrompt?: (task: string, angle: string) => string,
 *   buildJudgePrompt?: (task: string, drafts: Array<{ angle: string, text: string }>) => string,
 *   parseChoice?: (text: string, drafts: Array<object>) => { index: number | null, text: string },
 *   spawnAll?: Function,
 *   spawn?: Function,
 * }} opts
 * @returns {Promise<{ drafts: Array<object>, judge: object | null, choice: object }>}
 */
export async function multiAngle(task, opts) {
  requireAdapter(opts, "multiAngle");
  if (typeof task !== "string" || task.trim() === "") {
    throw new TypeError("multiAngle: task must be a non-empty string");
  }
  const angles = Array.isArray(opts.angles) && opts.angles.length > 0
    ? opts.angles
    : ["correctness", "simplicity", "robustness"];
  const buildDraftPrompt = opts.buildDraftPrompt ?? defaultDraftPrompt;
  const buildJudgePrompt = opts.buildJudgePrompt ?? defaultJudgePrompt;
  const parseChoice = opts.parseChoice ?? defaultChoiceParser;
  const spawnAll = opts.spawnAll ?? defaultSpawnAll;
  const spawn = opts.spawn ?? defaultSpawn;

  const draftSpecs = angles.map((angle, i) => ({
    id: `draft-${i}-${slug(angle)}`,
    agent: `draft-${slug(angle)}`,
    prompt: buildDraftPrompt(task, angle),
  }));
  const draftResults = await spawnAll(draftSpecs, forwardOpts(opts));
  const drafts = draftResults.map((res, i) => ({
    angle: angles[i],
    status: res.status,
    text: textOf(res),
  }));

  const judgeResult = await spawn(
    {
      id: "judge",
      agent: "judge",
      prompt: buildJudgePrompt(task, drafts),
    },
    forwardOpts(opts),
  );
  const judgeText = textOf(judgeResult);
  const choice = parseChoice(judgeText, drafts);

  return { drafts, judge: { status: judgeResult.status, text: judgeText }, choice };
}

function defaultDraftPrompt(task, angle) {
  return [
    `You are a drafting agent optimizing for: ${angle}.`,
    "",
    `Task: ${task}`,
    "",
    "Reply with your best self-contained answer. No preamble.",
  ].join("\n");
}

function defaultJudgePrompt(task, drafts) {
  const body = drafts
    .map((d, i) => `### Draft ${i + 1} (angle: ${d.angle})\n${d.text || "(empty)"}`)
    .join("\n\n");
  return [
    "You are a judge. Several drafts answer the same task from different angles.",
    "Pick the single strongest draft (or merge their best parts).",
    "",
    `Task: ${task}`,
    "",
    body,
    "",
    'Reply on the first line with "CHOICE: <draft number>" then the final answer on the following lines.',
  ].join("\n");
}

function defaultChoiceParser(text, drafts) {
  const m = String(text).match(/CHOICE:\s*(\d+)/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < drafts.length) {
      return { index: idx, text: text.replace(/^.*CHOICE:\s*\d+.*$/im, "").trim() || drafts[idx].text };
    }
  }
  return { index: null, text: String(text).trim() };
}

// ── fixLoop ──────────────────────────────────────────────────────────────────

/**
 * Repeatedly run `check`; while the loop hasn't converged, dispatch a fix
 * agent and re-check, up to `maxIters` iterations. `check` and `applyFix` are
 * caller-supplied so the loop stays agnostic about how building/testing/
 * patching actually happen.
 *
 * Convergence (#18): by default the loop stops when `check` reports ok. When
 * an `until` predicate is supplied it becomes the authoritative stop
 * condition — an externally checkable criterion (a test command exiting 0, an
 * artifact existing) that users can trust over "the agents said it's done".
 * Its `evidence` string is recorded in the history and the return value so
 * the caller can cite why the loop stopped. `stallRounds` stops the loop when
 * that many consecutive failing rounds produce an identical check report (no
 * observable progress).
 *
 * @param {{
 *   adapter?: import("./spawn.mjs").SubagentAdapter,
 *   maxIters?: number,
 *   stallRounds?: number,
 *   signal?: AbortSignal,
 *   runHandle?: object,
 *   check: (iteration: number) => Promise<{ ok: boolean, report?: string }>,
 *   until?: (iteration: number, check: { ok: boolean, report?: string }) => Promise<{ done: boolean, evidence?: string }> | { done: boolean, evidence?: string },
 *   buildFixPrompt?: (report: string, iteration: number) => string,
 *   applyFix?: (agentResult: object, iteration: number) => Promise<void> | void,
 *   spawn?: Function,
 * }} opts
 * @returns {Promise<{ ok: boolean, iterations: number, history: Array<object>, stopReason: "converged" | "stalled" | "max-iters", evidence?: string }>}
 */
export async function fixLoop(opts) {
  if (typeof opts?.check !== "function") {
    throw new TypeError("fixLoop: opts.check must be a function");
  }
  if (opts.until !== undefined && typeof opts.until !== "function") {
    throw new TypeError("fixLoop: opts.until must be a function when provided");
  }
  const maxIters = clampPositiveInt(opts.maxIters, 5, "maxIters");
  // 0 = stall detection disabled (the default).
  const stallRounds = clampPositiveInt(opts.stallRounds, 0, "stallRounds");
  const buildFixPrompt = opts.buildFixPrompt ?? defaultFixPrompt;
  const spawn = opts.spawn ?? defaultSpawn;
  const history = [];
  let lastReport;
  let stallCount = 0;

  for (let i = 0; i < maxIters; i += 1) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    const result = await opts.check(i);
    const entry = { iteration: i, ...result };
    // Convergence test: `until` when supplied (external criterion), otherwise
    // the check's own ok flag. `until` sees the check result so a single
    // predicate can combine both signals.
    let converged;
    let evidence;
    if (opts.until) {
      const verdict = await opts.until(i, result);
      converged = verdict?.done === true;
      if (verdict?.evidence !== undefined) {
        evidence = String(verdict.evidence);
        entry.evidence = evidence;
      }
    } else {
      converged = result.ok === true;
    }
    history.push(entry);
    if (converged) {
      return {
        ok: true,
        iterations: i + 1,
        history,
        stopReason: "converged",
        ...(evidence !== undefined ? { evidence } : {}),
      };
    }
    // Stall detection: a failing round whose report is byte-identical to the
    // previous one made no observable progress. Reset on any change so slow
    // but real progress never trips it.
    if (stallRounds > 0) {
      const report = result.report ?? "";
      stallCount = report === lastReport ? stallCount + 1 : 0;
      lastReport = report;
      if (stallCount >= stallRounds) {
        return {
          ok: false,
          iterations: i + 1,
          history,
          stopReason: "stalled",
          ...(evidence !== undefined ? { evidence } : {}),
        };
      }
    }
    // Not converged yet — attempt a fix unless this was the final allowed iteration.
    if (i === maxIters - 1) break;
    if (opts.adapter) {
      const fixResult = await spawn(
        {
          id: `fix-${i}`,
          agent: `fix-${i}`,
          prompt: buildFixPrompt(result.report ?? "", i),
        },
        forwardOpts(opts),
      );
      await opts.applyFix?.(fixResult, i);
    } else {
      await opts.applyFix?.(null, i);
    }
  }
  const last = history.at(-1);
  return {
    ok: false,
    iterations: history.length,
    history,
    stopReason: "max-iters",
    ...(last?.evidence !== undefined ? { evidence: last.evidence } : {}),
  };
}

function defaultFixPrompt(report, iteration) {
  return [
    `Iteration ${iteration}: the build/test check failed. Propose a concrete fix.`,
    "",
    "Failure report:",
    report || "(no report)",
    "",
    "Reply with the specific change(s) to make. Be precise and minimal.",
  ].join("\n");
}

// ── crossCheck ───────────────────────────────────────────────────────────────

/**
 * Verify each claim independently against multiple sources/perspectives and
 * aggregate a support rate per claim.
 *
 * @param {Array<string | { id?: string, text: string }>} claims
 * @param {{
 *   adapter: import("./spawn.mjs").SubagentAdapter,
 *   sources?: string[],
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   runHandle?: object,
 *   buildPrompt?: (claim: string, source: string) => string,
 *   parseVerdict?: (text: string) => { supported: boolean | null },
 *   spawnAll?: Function,
 * }} opts
 * @returns {Promise<{ checked: Array<object> }>}
 */
export async function crossCheck(claims, opts) {
  requireAdapter(opts, "crossCheck");
  if (!Array.isArray(claims) || claims.length === 0) return { checked: [] };
  const sources = Array.isArray(opts.sources) && opts.sources.length > 0
    ? opts.sources
    : ["first-principles", "counterexample", "authority"];
  const buildPrompt = opts.buildPrompt ?? defaultCrossCheckPrompt;
  const parseVerdict = opts.parseVerdict ?? defaultSupportParser;
  const spawnAll = opts.spawnAll ?? defaultSpawnAll;

  const items = claims.map((c, i) => normalizeFinding(c, i));
  // One spec per (claim, source). Folding the source index `sIdx` into the spec
  // id keeps ids unique even when two sources slugify to the same token (R6);
  // fanOutPerItem regroups by exact spec id and hands back each source verdict in
  // order, so prefix-sharing or duplicate ids can't cross-contaminate rates.
  const grouped = await fanOutPerItem(items, sources, {
    specId: (item, source, sIdx) => `check-${item.index}-${item.id}-s${sIdx}-${slug(source)}`,
    buildPrompt: (item, source) => buildPrompt(item.text, source),
    forward: forwardOpts(opts),
    spawnAll,
  });

  const checked = grouped.map(({ item, owned }) => {
    const verdicts = owned.map(({ variant: source, result: res }) => {
      if (res.status !== "ok") return { source, supported: null };
      return { source, ...parseVerdict(textOf(res)) };
    });
    const decided = verdicts.filter((v) => v.supported !== null);
    const supportedCount = verdicts.filter((v) => v.supported === true).length;
    const supportRate = decided.length ? supportedCount / decided.length : 0;
    return { ...item, verdicts, supportRate, confidence: supportRate };
  });

  return { checked };
}

function defaultCrossCheckPrompt(claim, source) {
  return [
    `Evaluate the claim below from this perspective: ${source}.`,
    "",
    `Claim: ${claim}`,
    "",
    'Reply on a single line starting with "SUPPORTED: YES" or "SUPPORTED: NO", then one sentence of reasoning.',
  ].join("\n");
}

function defaultSupportParser(text) {
  const t = String(text).toUpperCase();
  // Check negative phrasing first so "NOT SUPPORTED" / "UNSUPPORTED" / "SUPPORTED: NO"
  // are never swallowed by the bare positive token below.
  if (/SUPPORTED:\s*NO|\bNOT\s+SUPPORTED\b|\bUNSUPPORTED\b/.test(t)) {
    return { supported: false };
  }
  if (/SUPPORTED:\s*YES|\bSUPPORTED\b/.test(t)) {
    return { supported: true };
  }
  return { supported: null };
}

// ── shared helpers ───────────────────────────────────────────────────────────

/**
 * Shared fan-out used by adversarialReview and crossCheck: expand each item into
 * one spec per variant, run them all through spawnAll, and return each item with
 * the results it owns — grouped by exact spec id (never by string prefix) and in
 * variant order, with the originating variant attached. Both callers previously
 * rebuilt this specs[]/ownSpecIds[] machinery (and the prefix-collision guard)
 * by hand.
 *
 * @template V
 * @param {Array<{ id: string, index: number, text: string }>} items
 * @param {V[]} variants
 * @param {{
 *   specId: (item: object, variant: V, variantIdx: number) => string,
 *   buildPrompt: (item: object, variant: V, variantIdx: number) => string,
 *   forward: object,
 *   spawnAll: Function,
 * }} cfg
 * @returns {Promise<Array<{ item: object, owned: Array<{ variant: V, variantIdx: number, result: object }> }>>}
 */
async function fanOutPerItem(items, variants, { specId, buildPrompt, forward, spawnAll }) {
  const specs = [];
  const ownership = items.map(() => []);
  items.forEach((item, itemIdx) => {
    variants.forEach((variant, variantIdx) => {
      const id = specId(item, variant, variantIdx);
      specs.push({ id, agent: id, prompt: buildPrompt(item, variant, variantIdx) });
      ownership[itemIdx].push({ id, variant, variantIdx });
    });
  });
  const results = await spawnAll(specs, forward);
  const byId = new Map(results.map((res) => [res.spec.id, res]));
  return items.map((item, itemIdx) => ({
    item,
    owned: ownership[itemIdx].map(({ id, variant, variantIdx }) => ({
      variant,
      variantIdx,
      result: byId.get(id),
    })),
  }));
}

function requireAdapter(opts, who) {
  if (!opts?.adapter) throw new TypeError(`${who}: opts.adapter is required`);
}

function forwardOpts(opts) {
  return {
    adapter: opts.adapter,
    concurrency: opts.concurrency,
    signal: opts.signal,
    runHandle: opts.runHandle,
    retries: opts.retries,
    retryBaseMs: opts.retryBaseMs,
  };
}

function normalizeFinding(f, index) {
  const text = typeof f === "string" ? f : String(f?.text ?? "");
  const id = (typeof f === "object" && f?.id ? String(f.id) : `f${index}`);
  return { id: slug(id), index, text };
}

function slug(s) {
  return String(s).trim().replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

function firstLine(text) {
  return String(text).split("\n")[0].trim().slice(0, 200);
}

function clampPositiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer (got ${value})`);
  }
  return value;
}

function clampFraction(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a number in [0, 1] (got ${value})`);
  }
  return value;
}
