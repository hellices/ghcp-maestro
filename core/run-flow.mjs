// Run-lifecycle IO helpers shared by the workflow handlers. Unlike
// workflow-log.mjs (pure string formatters, no IO), these helpers perform side
// effects — they transition a run's manifest state and write to the session
// log — so they live in their own module and take `session`/`run` explicitly,
// which keeps them unit-testable with fakes.

import { releaseRun } from "./run-registry.mjs";
import { buildTraceSpans } from "./trace.mjs";
import { writeJsonAtomic } from "./run-store.mjs";
import { join } from "node:path";

/**
 * Best-effort OTel GenAI-style trace export (#32): write `trace.json` into the
 * run dir from the manifest + cached agent records. Never throws — tracing
 * must not break a run's terminal transition. No-op for run handles that lack
 * the run-store surface (fakes, resume probes).
 *
 * @param {{ runDir?: string, manifest?: object, listAgents?: () => Promise<object[]> } | undefined} run
 * @returns {Promise<void>}
 */
export async function writeRunTrace(run) {
  try {
    if (!run?.runDir || !run?.manifest || typeof run.listAgents !== "function") return;
    const agents = await run.listAgents();
    const trace = buildTraceSpans({ manifest: run.manifest, agents });
    await writeJsonAtomic(join(run.runDir, "trace.json"), trace);
  } catch {
    // best-effort — a trace write failure must never mask the run outcome
  }
}

/**
 * Mark a run failed, log the reason at error level, and return the run handle so
 * a caller can `return failRun(...)`. Centralises the abort boilerplate every
 * workflow failure branch repeats. The run handle is optional-chained so the
 * resume/probe paths (where the run may be undefined) can share this helper.
 * The manifest patch is best-effort: if it rejects (e.g. a disk IO error) the
 * error message is still logged.
 *
 * @param {{ log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown> }} session
 * @param {{ patchManifest?: (patch: object) => unknown | Promise<unknown>, runId?: string } | undefined} run
 * @param {string} message
 * @param {object} [extraPatch] - extra manifest fields to persist with the error status (e.g. tokensUsed)
 * @returns {Promise<object | undefined>} the same run handle that was passed in
 */
export async function failRun(session, run, message, extraPatch = {}) {
  // Persisting the terminal status is best-effort: an IO failure here must never
  // swallow the user-facing error log below (that log is the whole point).
  try {
    await run?.patchManifest?.({ status: "error", finishedAt: Date.now(), ...extraPatch });
  } catch {
    // ignore — fall through to log the original failure
  }
  await writeRunTrace(run);
  if (run?.runId) releaseRun(run.runId);
  await session.log(message, { level: "error" });
  return run;
}

/**
 * Mark a run complete and always drop its process-local abort controller —
 * even when persisting the terminal manifest fails (disk IO error), the
 * registry entry must not leak for the life of the process. The error itself
 * still propagates so the caller's failure path (background error log /
 * failRun) can surface it.
 *
 * @param {{ complete: () => unknown | Promise<unknown>, runId?: string }} run
 * @returns {Promise<void>}
 */
export async function completeRun(run) {
  try {
    await run.complete();
    await writeRunTrace(run);
  } finally {
    if (run?.runId) releaseRun(run.runId);
  }
}
