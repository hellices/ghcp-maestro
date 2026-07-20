// Shared phase-execution helper.
//
// Every workflow phase — the single-agent plan/synth phases and the N-agent
// explore fan-outs — followed the same four-step choreography:
//
//   const monitor = startPhaseMonitor({ runId, run, phase, specs });
//   const results = await spawnAll(specs, {
//     adapter, runHandle: run,
//     onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
//   });
//   for (const r of results) monitor?.settle(r.spec.id, r.status === "ok");
//   monitor?.flush();
//
// It was copy-pasted eight times across the built-in workflows. Repeating it by
// hand is a foot-gun: forget the settle-loop or the flush and progress.json goes
// permanently stale for that phase. runPhase owns the choreography once so a
// phase is a single call that returns the results (plus the phase wall-clock).
//
// No IO of its own beyond what the injected monitor/spawnAll do. The two
// collaborators default to the real runtime implementations but are injectable
// so the choreography is unit-testable without a live adapter.

import { spawnAll as defaultSpawnAll } from "./spawn.mjs";
import { startPhaseMonitor as defaultStartPhaseMonitor } from "./phase-monitor.mjs";
import { ensureRunController as defaultEnsureRunController } from "./run-registry.mjs";

/**
 * Run one workflow phase end-to-end: seed the phase monitor, fan the specs out
 * through spawnAll (streaming progress into the monitor), settle every result,
 * and flush the final snapshot. Never throws for individual agent failures —
 * those are reflected in each result's `status`.
 *
 * @param {import("./spawn.mjs").AgentSpec[]} specs
 * @param {{
 *   run: object,
 *   runId: string,
 *   phase: string,
 *   adapter: import("./spawn.mjs").SubagentAdapter,
 *   signal?: AbortSignal,
 *   concurrency?: number,
 *   now?: () => number,
 *   spawnAll?: typeof defaultSpawnAll,
 *   startPhaseMonitor?: typeof defaultStartPhaseMonitor,
 *   ensureRunController?: typeof defaultEnsureRunController,
 * }} opts
 * @returns {Promise<{ results: import("./spawn.mjs").AgentResult[], elapsedMs: number }>}
 */
export async function runPhase(specs, opts) {
  const {
    run,
    runId,
    phase,
    adapter,
    signal,
    concurrency,
    now = Date.now,
    spawnAll = defaultSpawnAll,
    startPhaseMonitor = defaultStartPhaseMonitor,
    ensureRunController = defaultEnsureRunController,
  } = opts;

  // When the caller doesn't manage its own AbortSignal (the CLI workflows),
  // fall back to the run's process-local controller so /maestro-stop can abort
  // in-flight agents and prevent later phases of the same run from starting.
  const effectiveSignal = signal ?? (runId ? ensureRunController(runId).signal : undefined);

  const monitor = startPhaseMonitor({ runId, run, phase, specs });
  const startedAt = now();
  const results = await spawnAll(specs, {
    adapter,
    runHandle: run,
    ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
  });
  for (const r of results) monitor?.settle(r.spec.id, r.status === "ok");
  monitor?.flush();
  return { results, elapsedMs: now() - startedAt };
}
