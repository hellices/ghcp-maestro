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
 * When the total payload exceeds MAX_AGENT_DIGEST_CHARS, per-agent output
 * bodies are truncated fairly (equal budget per result) with an explicit
 * `…[truncated]` marker. Every agent heading is always preserved so the
 * synth/verify prompt sees the full list.
 *
 * Small digests are byte-identical to the pre-bounding shape.
 *
 * @param {AgentResultLike[]} results
 * @param {{ emptyPlaceholder?: string }} [opts]
 * @returns {string}
 */
export function agentDigest(results, opts = {}) {
  // Phase 1: compute the unbounded per-entry body text.
  const entries = results.map((r) => {
    if (r.status && r.status !== "ok") {
      const reason = r.error ? ` — ${r.error}` : "";
      return {
        heading: `## ${r.spec.agent} (FAILED: ${r.status})`,
        body: `(this angle is missing${reason})`,
      };
    }
    const body = text(r) || (opts.emptyPlaceholder ?? "");
    return { heading: `## ${r.spec.agent}`, body };
  });

  // Phase 2: check if the naive join fits. When it does, return it directly
  // (byte-identical to the pre-bounding shape).
  const naiveJoin = () =>
    entries.map((e) => `${e.heading}\n${e.body}`).join("\n\n");
  const naive = naiveJoin();
  if (naive.length <= MAX_AGENT_DIGEST_CHARS) return naive;

  // Phase 3: distribute the total payload budget across entries.
  // Headings + "\n" separators are overhead that must fit unconditionally.
  const overhead = entries.reduce(
    (n, e, i) => n + e.heading.length + 1 /* \n */ + (i > 0 ? 2 : 0) /* \n\n */,
    0,
  );
  const bodyBudget = Math.max(0, MAX_AGENT_DIGEST_CHARS - overhead);
  const perEntry = Math.max(1, Math.floor(bodyBudget / entries.length));
  const MARKER = "…[truncated]";
  for (const e of entries) {
    if (e.body.length > perEntry) {
      e.body = e.body.slice(0, Math.max(0, perEntry - MARKER.length)) + MARKER;
    }
  }
  return entries.map((e) => `${e.heading}\n${e.body}`).join("\n\n");
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
