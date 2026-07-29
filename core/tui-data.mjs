// Data access for the maestro-top viewer (issue #46).
//
// Read-only over the run store: resolve which run to follow and read one
// coherent "frame" (manifest + progress snapshot + event tails for expanded
// agents). All reads go through run-store helpers, which tolerate missing
// files — a frame can always be rendered, even mid-run or mid-write (the
// store's writes are atomic renames).

import { listRuns, openRun } from "./run-store.mjs";

/**
 * Pick the run to follow when none was given: the newest run that is still
 * `running`, else the newest run overall. Undefined when the store is empty.
 *
 * @param {{ baseDir?: string }} [opts]
 * @returns {Promise<string | undefined>}
 */
export async function resolveTargetRunId(opts = {}) {
  const runs = await listRuns({ baseDir: opts.baseDir });
  if (runs.length === 0) return undefined;
  const active = runs.find((m) => m.status === "running");
  return (active ?? runs[0]).runId;
}

/**
 * Read one frame of a run for rendering: its manifest, the latest progress
 * snapshot (undefined before the first phase flush), and the recent event
 * tail for each agent id in `expandedAgentIds` (collapsed agents are not
 * tailed — reading every ndjson on every poll would be wasteful).
 *
 * Returns undefined when the run does not exist.
 *
 * @param {string} runId
 * @param {{ baseDir?: string, expandedAgentIds?: string[], eventLimit?: number }} [opts]
 * @returns {Promise<{ manifest: object, snapshot: object | undefined, events: Record<string, object[]> } | undefined>}
 */
export async function readRunFrame(runId, opts = {}) {
  let run;
  try {
    run = await openRun(runId, { baseDir: opts.baseDir });
  } catch {
    return undefined;
  }
  const snapshot = await run.readProgress();
  const events = {};
  for (const agentId of opts.expandedAgentIds ?? []) {
    try {
      events[agentId] = await run.readAgentEvents(agentId, { limit: opts.eventLimit ?? 12 });
    } catch {
      // unsafe/foreign id or torn read — leave the agent un-tailed
    }
  }
  return { manifest: run.manifest, snapshot, events };
}
