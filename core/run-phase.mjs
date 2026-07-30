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
import {
  ensureRunController as defaultEnsureRunController,
  ensureAgentController as defaultEnsureAgentController,
  abortAgent as defaultAbortAgent,
} from "./run-registry.mjs";
import { consumeControlRequests, applyControlRequests } from "./tui-control.mjs";

const DEFAULT_CONTROL_POLL_MS = 1000;

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
 *   budget?: { add: (n: unknown) => void, exceeded: () => boolean },
 *   now?: () => number,
 *   spawnAll?: typeof defaultSpawnAll,
 *   startPhaseMonitor?: typeof defaultStartPhaseMonitor,
 *   ensureRunController?: typeof defaultEnsureRunController,
 *   registry?: { ensureAgentController: Function, abortAgent: Function },
 *   controlPollMs?: number,
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
    budget,
    now = Date.now,
    spawnAll = defaultSpawnAll,
    startPhaseMonitor = defaultStartPhaseMonitor,
    ensureRunController = defaultEnsureRunController,
    registry = { ensureAgentController: defaultEnsureAgentController, abortAgent: defaultAbortAgent },
    controlPollMs = DEFAULT_CONTROL_POLL_MS,
  } = opts;

  // When the caller doesn't manage its own AbortSignal (the CLI workflows),
  // fall back to the run's process-local controller so /maestro-stop can abort
  // in-flight agents and prevent later phases of the same run from starting.
  const effectiveSignal = signal ?? (runId ? ensureRunController(runId).signal : undefined);

  // Per-agent control channel (issue #46): while the fan-out is in flight, an
  // external TUI can drop `control/<agentId>.json` stop requests into the run
  // dir. The poller drains them and aborts just that agent's signal; the rest
  // of the phase keeps running. Only active when the run is persisted.
  const controllable = Boolean(runId && run?.runDir);
  const getAgentSignal = controllable
    ? (id) => registry.ensureAgentController(runId, id).signal
    : undefined;
  let controlTimer;
  if (controllable) {
    const poll = async () => {
      try {
        const requests = await consumeControlRequests(run.runDir);
        applyControlRequests(requests, { runId, registry });
      } catch {
        // best-effort: a broken control dir must never break the phase
      }
    };
    controlTimer = setInterval(poll, controlPollMs);
    controlTimer.unref?.();
    void poll(); // drain anything queued before the phase started
  }

  const monitor = startPhaseMonitor({ runId, run, phase, specs });
  const startedAt = now();
  try {
    const results = await spawnAll(specs, {
      adapter,
      runHandle: run,
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(getAgentSignal !== undefined ? { getAgentSignal } : {}),
      onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
    });
    for (const r of results) monitor?.settle(r.spec.id, r.status === "ok");
    monitor?.flush();
    return { results, elapsedMs: now() - startedAt };
  } finally {
    if (controlTimer) clearInterval(controlTimer);
  }
}
