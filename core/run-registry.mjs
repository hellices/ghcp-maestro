// In-process run cancellation registry.
//
// Maps runId → AbortController so /maestro-stop can actually interrupt a run's
// in-flight agents (issue: stopRun used to only flip the manifest to "stopped"
// while agents kept burning tokens). The registry is process-local by design:
// the CLI extension runs every background workflow in its own process, so the
// controller for a run is always reachable from the /maestro-stop handler.
// Cross-process stops still degrade gracefully to the manifest-only behaviour.
//
// Lifecycle: runPhase lazily creates a run's controller on first use and every
// later phase of the same run reuses it, so an abort between phases still stops
// the next phase from fanning out. `abortRun` removes the entry after aborting
// so a later /maestro-resume of the same run gets a fresh controller.

/**
 * Create an isolated registry. The module also exports a process-wide default
 * (`ensureRunController` / `abortRun` / `releaseRun`) that the runtime uses;
 * tests build their own via this factory.
 */
export function createRunRegistry() {
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();
  /** @type {Map<string, Map<string, AbortController>>} runId → agentId → controller */
  const agentControllers = new Map();

  return {
    /**
     * Get (or lazily create) the AbortController for a run.
     * @param {string} runId
     * @returns {AbortController}
     */
    ensureRunController(runId) {
      let controller = controllers.get(runId);
      if (!controller) {
        controller = new AbortController();
        controllers.set(runId, controller);
      }
      return controller;
    },

    /**
     * Abort a run's in-flight agents, if this process owns a controller for it.
     * The entry is removed afterwards so a later resume starts fresh.
     * @param {string} runId
     * @param {unknown} [reason]
     * @returns {boolean} true when a live controller was found and aborted
     */
    abortRun(runId, reason) {
      const controller = controllers.get(runId);
      if (!controller) return false;
      controllers.delete(runId);
      controller.abort(reason ?? new Error(`run ${runId} stopped by user`));
      return true;
    },

    /**
     * Drop a run's controller without aborting (terminal-state cleanup).
     * Per-agent controllers of the run are dropped with it.
     * @param {string} runId
     */
    releaseRun(runId) {
      controllers.delete(runId);
      agentControllers.delete(runId);
    },

    /**
     * Get (or lazily create) the AbortController for one agent of one run.
     * Used by the maestro-top control channel (issue #46) to stop a single
     * agent without aborting the whole fan-out.
     * @param {string} runId
     * @param {string} agentId
     * @returns {AbortController}
     */
    ensureAgentController(runId, agentId) {
      let byAgent = agentControllers.get(runId);
      if (!byAgent) {
        byAgent = new Map();
        agentControllers.set(runId, byAgent);
      }
      let controller = byAgent.get(agentId);
      if (!controller) {
        controller = new AbortController();
        byAgent.set(agentId, controller);
      }
      return controller;
    },

    /**
     * Abort one agent of one run, if this process owns a controller for it.
     * The entry is removed afterwards so a retry of the agent starts fresh.
     * @param {string} runId
     * @param {string} agentId
     * @param {unknown} [reason]
     * @returns {boolean} true when a live controller was found and aborted
     */
    abortAgent(runId, agentId, reason) {
      const controller = agentControllers.get(runId)?.get(agentId);
      if (!controller) return false;
      agentControllers.get(runId).delete(agentId);
      controller.abort(reason ?? new Error(`agent ${agentId} of run ${runId} stopped by user`));
      return true;
    },

    /** Number of live controllers (diagnostics/tests). */
    get size() {
      return controllers.size;
    },
  };
}

const defaultRegistry = createRunRegistry();

export const ensureRunController = (runId) => defaultRegistry.ensureRunController(runId);
export const abortRun = (runId, reason) => defaultRegistry.abortRun(runId, reason);
export const releaseRun = (runId) => defaultRegistry.releaseRun(runId);
export const ensureAgentController = (runId, agentId) =>
  defaultRegistry.ensureAgentController(runId, agentId);
export const abortAgent = (runId, agentId, reason) =>
  defaultRegistry.abortAgent(runId, agentId, reason);
