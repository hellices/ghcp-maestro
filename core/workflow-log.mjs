// Pure formatters for the built-in workflow phase logs (hello / brainstorm /
// task). Extracted so the three handlers stop duplicating the same log-string
// construction. No IO here — callers pass the strings to session.log.

/** Per-agent output cap — truncate any single agent's body to this length. */
export const MAX_AGENT_OUTPUT_CHARS = 4_000;

/** Total digest cap — the entire agentDigest string must not exceed this. */
export const MAX_AGENT_DIGEST_CHARS = 64_000;

/**
 * @typedef {{
 *   spec: { agent?: string },
 *   status?: string,
 *   error?: string,
 *   cached?: boolean,
 *   startedAt: number,
 *   finishedAt: number,
 *   output?: { text?: string },
 * }} AgentResultLike - `status` may be absent on digest-only inputs (treated
 *   as ok); `error` carries the failure text rendered in FAILED blocks.
 */

function text(result) {
  return (result?.output?.text ?? "").trim();
}

function cachedTag(result) {
  return result?.cached ? " (cached)" : "";
}

/**
 * One explore/fan-out result line. Two variants preserve the pre-existing
 * formats exactly:
 *   - "preview": `… chars=<n> preview=<json first line, <=100 chars>`
 *     (brainstorm + task)
 *   - "reply":   `… reply=<json full text, <=40 chars>` (hello)
 *
 * @param {string} runId
 * @param {AgentResultLike} result
 * @param {{ mode: "preview" | "reply" }} opts
 * @returns {string}
 */
export function exploreResultLine(runId, result, opts) {
  const agent = result?.spec?.agent;
  const took = result.finishedAt - result.startedAt;
  const base = `ghcp-maestro/${runId}: explore/${agent} status=${result.status}${cachedTag(result)} took=${took}ms`;
  if (opts.mode === "reply") {
    const preview = text(result).slice(0, 40);
    return `${base} reply=${JSON.stringify(preview)}`;
  }
  const t = text(result);
  const firstLine = t.split("\n")[0] ?? "";
  return `${base} chars=${t.length} preview=${JSON.stringify(firstLine.slice(0, 100))}`;
}

/**
 * The "phase=explore wall-clock=<ms> (parallel of <n>)" summary line.
 * @param {string} runId
 * @param {number} elapsedMs
 * @param {number} count
 * @returns {string}
 */
export function wallClockLine(runId, elapsedMs, count) {
  return `ghcp-maestro/${runId}: phase=explore wall-clock=${elapsedMs}ms (parallel of ${count})`;
}

/**
 * Summarise the failed agents in a fan-out, or null when none failed.
 * @param {string} runId
 * @param {AgentResultLike[]} results
 * @param {string} label - e.g. "explore" or "subtask"
 * @returns {string | null}
 */
export function fanoutFailureSummary(runId, results, label) {
  const failed = results.filter((r) => r.status !== "ok");
  if (failed.length === 0) return null;
  const detail = failed.map((r) => `${r.spec.agent}=${r.status}`).join(", ");
  return `ghcp-maestro/${runId}: ${failed.length}/${results.length} ${label} agent(s) failed: ${detail}`;
}

/**
 * True when every result is non-ok (and there is at least one result).
 * @param {AgentResultLike[]} results
 * @returns {boolean}
 */
export function allFailed(results) {
  return results.length > 0 && results.every((r) => r.status !== "ok");
}

/**
 * Build the "## <agent>\n<output>" digest fed to a synth agent.
 *
 * Per-agent output bodies are hard-capped to MAX_AGENT_OUTPUT_CHARS (with a
 * truncation marker). When the total payload exceeds MAX_AGENT_DIGEST_CHARS,
 * per-agent output bodies are truncated fairly (equal budget per result).
 * Every agent heading is preserved for the `/maestro task` supported maximum
 * of 50; for arbitrarily large saved-workflow inputs where headings alone
 * overflow, long names are compacted and excess entries are omitted with an
 * explicit summary.
 *
 * Small digests are byte-identical to the pre-bounding shape.
 *
 * @param {AgentResultLike[]} results
 * @param {{ emptyPlaceholder?: string }} [opts]
 * @returns {string}
 */
export function agentDigest(results, opts = {}) {
  const MARKER = "…[truncated]";

  // Phase 1: compute per-entry heading + body, with per-agent body cap.
  const entries = results.map((r) => {
    let heading, body;
    if (r.status && r.status !== "ok") {
      heading = `## ${r.spec.agent} (FAILED: ${r.status})`;
      const reason = r.error ? ` — ${r.error}` : "";
      body = `(this angle is missing${reason})`;
    } else {
      heading = `## ${r.spec.agent}`;
      body = text(r) || (opts.emptyPlaceholder ?? "");
    }
    if (body.length > MAX_AGENT_OUTPUT_CHARS) {
      body = body.slice(0, Math.max(0, MAX_AGENT_OUTPUT_CHARS - MARKER.length)) + MARKER;
    }
    return { heading, body };
  });

  const join = (es) => es.map((e) => `${e.heading}\n${e.body}`).join("\n\n");

  // Phase 2: if the per-agent-capped join fits, return it directly
  // (byte-identical to the pre-bounding shape for small runs).
  const naive = join(entries);
  if (naive.length <= MAX_AGENT_DIGEST_CHARS) return naive;

  // Phase 3: all headings fit — distribute remaining body budget fairly.
  const overheadOf = (es) =>
    es.reduce((n, e, i) => n + e.heading.length + 1 + (i > 0 ? 2 : 0), 0);
  const overhead = overheadOf(entries);
  if (overhead <= MAX_AGENT_DIGEST_CHARS) {
    const bodyBudget = MAX_AGENT_DIGEST_CHARS - overhead;
    const perEntry = Math.floor(bodyBudget / entries.length);
    for (const e of entries) {
      if (e.body.length > perEntry) {
        e.body = perEntry <= MARKER.length ? "" : e.body.slice(0, perEntry - MARKER.length) + MARKER;
      }
    }
    return join(entries);
  }

  // Phase 4: headings overflow — compact long names, drop bodies.
  const COMPACT_NAME_LEN = 20;
  for (const e of entries) {
    const m = e.heading.match(/^## (.+?)( \(FAILED: .+\))?$/);
    if (m && m[1].length > COMPACT_NAME_LEN) {
      e.heading = `## ${m[1].slice(0, COMPACT_NAME_LEN - 1)}…${m[2] ?? ""}`;
    }
    e.body = "";
  }
  const compactOverhead = overheadOf(entries);
  if (compactOverhead <= MAX_AGENT_DIGEST_CHARS) return join(entries);

  // Phase 5: even compacted headings don't fit — include what we can + omission summary.
  const included = [];
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const entryCost = (included.length > 0 ? 2 : 0) + e.heading.length + 1;
    const omitted = entries.length - (included.length + 1);
    const omissionText = omitted > 0 ? `…[${omitted} more agent(s) omitted]` : "";
    const omissionCost = omitted > 0 ? 2 + omissionText.length : 0;
    if (used + entryCost + omissionCost <= MAX_AGENT_DIGEST_CHARS) {
      included.push(e);
      used += entryCost;
    } else {
      break;
    }
  }
  const omitted = entries.length - included.length;
  if (omitted === 0) return join(included);
  const omissionLine = `…[${omitted} more agent(s) omitted]`;
  if (included.length === 0) return omissionLine;
  return `${join(included)}\n\n${omissionLine}`;
}

/**
 * The "coverage: N/M subtasks ok (…)" line logged with the final answer, so a
 * partially-failed fan-out is visible at a glance.
 *
 * @param {string} runId
 * @param {AgentResultLike[]} results
 * @returns {string}
 */
export function coverageLine(runId, results) {
  const ok = results.filter((r) => r.status === "ok").length;
  const base = `ghcp-maestro/${runId}: coverage: ${ok}/${results.length} subtasks ok`;
  if (ok === results.length) return base;
  const counts = new Map();
  for (const r of results) {
    if (r.status !== "ok") counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  const detail = [...counts.keys()]
    .sort()
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return `${base} (${detail})`;
}

/**
 * The trimmed body a dump line echoes. Only a null/undefined output collapses to
 * "(empty)"; an explicit empty string stays empty after trimming.
 * @param {AgentResultLike} result
 * @returns {string}
 */
function dumpBody(result) {
  return (result?.output?.text ?? "(empty)").trim();
}

/**
 * The per-agent "FULL ↓" dump line that echoes a subagent's whole output into
 * the session log.
 * @param {string} runId
 * @param {AgentResultLike} result
 * @returns {string}
 */
export function exploreFullDumpLine(runId, result) {
  const agent = result?.spec?.agent;
  return `ghcp-maestro/${runId}: explore/${agent} FULL ↓\n${dumpBody(result)}`;
}

/**
 * A labelled full-output dump (e.g. synth's "FINAL ANSWER ↓" / "TOP 3 NEXT
 * STEPS ↓"). Same body semantics as exploreFullDumpLine but with a caller-chosen
 * header instead of "explore/<agent> FULL".
 * @param {string} runId
 * @param {string} label
 * @param {AgentResultLike} result
 * @returns {string}
 */
export function labeledDumpLine(runId, label, result) {
  return `ghcp-maestro/${runId}: ${label} ↓\n${dumpBody(result)}`;
}

/**
 * The synth-phase status line. The task workflow appends a wall-clock segment;
 * the brainstorm workflow omits it.
 * @param {string} runId
 * @param {AgentResultLike} result
 * @param {{ wallMs?: number }} [opts]
 * @returns {string}
 */
export function synthStatusLine(runId, result, opts = {}) {
  const took = result.finishedAt - result.startedAt;
  const wall = opts.wallMs != null ? ` wall=${opts.wallMs}ms` : "";
  return `ghcp-maestro/${runId}: synth status=${result.status}${cachedTag(result)} took=${took}ms${wall}`;
}

/**
 * Emit the shared explore/fan-out logging sequence both the brainstorm and task
 * workflows duplicate: a preview line per result, the wall-clock summary, the
 * full per-agent output dumps, then a warning-level failure summary when any
 * agent failed. IO is delegated to the caller-supplied `log` so this stays
 * unit-testable and decoupled from session.
 *
 * @param {{
 *   runId: string,
 *   results: AgentResultLike[],
 *   elapsedMs: number,
 *   count: number,
 *   label: string,
 *   log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown>,
 * }} params
 * @returns {Promise<void>}
 */
export async function logExploreResults({ runId, results, elapsedMs, count, label, log }) {
  for (const r of results) {
    await log(exploreResultLine(runId, r, { mode: "preview" }));
  }
  await log(wallClockLine(runId, elapsedMs, count));
  for (const r of results) {
    await log(exploreFullDumpLine(runId, r));
  }
  const summary = fanoutFailureSummary(runId, results, label);
  if (summary) await log(summary, { level: "warning" });
}
