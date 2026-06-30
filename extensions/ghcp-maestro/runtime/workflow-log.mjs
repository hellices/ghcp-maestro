// Pure formatters for the built-in workflow phase logs (hello / brainstorm /
// task). Extracted so the three handlers stop duplicating the same log-string
// construction. No IO here — callers pass the strings to session.log.

/**
 * @typedef {{
 *   spec: { agent?: string },
 *   status: string,
 *   cached?: boolean,
 *   startedAt: number,
 *   finishedAt: number,
 *   output?: { text?: string },
 * }} AgentResultLike
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
 * @param {AgentResultLike[]} results
 * @param {{ emptyPlaceholder?: string }} [opts]
 * @returns {string}
 */
export function agentDigest(results, opts = {}) {
  return results
    .map((r) => {
      const body = text(r) || (opts.emptyPlaceholder ?? "");
      return `## ${r.spec.agent}\n${body}`;
    })
    .join("\n\n");
}
