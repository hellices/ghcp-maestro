// Phase monitor (issue: plan/synth phases were a monitoring blind spot).
//
// The task workflow runs in three phases — plan → explore → synth — but only
// the explore fan-out reported progress. The single-agent plan and synth phases
// ran with no `onProgress` sink, so `progress.json` was not written during them
// and `/maestros <runId>` showed "no progress recorded yet" while the planner
// (which can run for minutes) decomposed the task.
//
// startPhaseMonitor wraps createMonitor so every phase — single-agent or
// fan-out — reports the same way: it seeds the phase's agents and flushes once
// up front so the pending snapshot lands the instant a phase begins, then the
// caller threads the returned monitor's onProgress/settle through spawnAll.
//
// This persists to progress.json only (via run.writeProgress); it never pushes
// to the session, matching the on-demand /maestros model.

import { createMonitor } from "./monitor.mjs";
import { monitorEnabled } from "./env-flags.mjs";

/**
 * @param {{
 *   runId: string,
 *   run: { writeProgress: (snap: object) => Promise<void> | unknown },
 *   phase: string,
 *   specs: Array<{ id: string, agent: string }>,
 *   env?: object,
 *   now?: () => number,
 * }} opts
 * @returns {ReturnType<typeof createMonitor> | null}
 */
export function startPhaseMonitor(opts) {
  if (!monitorEnabled(opts.env ?? process.env)) return null;
  const monitor = createMonitor({
    label: `ghcp-maestro/${opts.runId} ${opts.phase}`,
    render: (_text, snap) => {
      Promise.resolve(opts.run.writeProgress(snap)).catch(() => {});
    },
    now: opts.now,
  });
  monitor.seed((opts.specs ?? []).map((s) => ({ id: s.id, agent: s.agent })));
  // Flush once up front: record the phase's pending agents immediately so a
  // concurrent /maestros <runId> shows the phase the moment it starts, before
  // any agent has produced output.
  monitor.flush();

  // When the run handle can persist per-agent event streams, tee every
  // progress event (and the terminal settle) into logs/<agentId>.ndjson for
  // the maestro-top viewer's drill-down. Best-effort: an append failure must
  // never break progress reporting, and old handles without the method work
  // unchanged.
  const appendEvent = typeof opts.run.appendAgentEvent === "function" ? opts.run.appendAgentEvent.bind(opts.run) : null;
  if (!appendEvent) return monitor;
  const phase = opts.phase;
  return {
    ...monitor,
    onProgress(evt) {
      if (evt?.specId) {
        const { specId, ...fields } = evt;
        Promise.resolve(appendEvent(specId, { phase, ...fields })).catch(() => {});
      }
      monitor.onProgress(evt);
    },
    settle(specId, ok) {
      if (specId) {
        Promise.resolve(appendEvent(specId, { phase, state: ok ? "done" : "failed" })).catch(
          () => {},
        );
      }
      monitor.settle(specId, ok);
    },
  };
}
