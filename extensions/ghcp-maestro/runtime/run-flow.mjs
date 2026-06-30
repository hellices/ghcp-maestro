// Run-lifecycle IO helpers shared by the workflow handlers. Unlike
// workflow-log.mjs (pure string formatters, no IO), these helpers perform side
// effects — they transition a run's manifest state and write to the session
// log — so they live in their own module and take `session`/`run` explicitly,
// which keeps them unit-testable with fakes.

/**
 * Mark a run failed, log the reason at error level, and return the run handle so
 * a caller can `return failRun(...)`. Centralises the abort boilerplate every
 * workflow failure branch repeats. The run handle is optional-chained so the
 * resume/probe paths (where the run may be undefined) can share this helper.
 * The manifest patch is best-effort: if it rejects (e.g. a disk IO error) the
 * error message is still logged.
 *
 * @param {{ log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown> }} session
 * @param {{ patchManifest?: (patch: object) => unknown | Promise<unknown> } | undefined} run
 * @param {string} message
 * @returns {Promise<object | undefined>} the same run handle that was passed in
 */
export async function failRun(session, run, message) {
  // Persisting the terminal status is best-effort: an IO failure here must never
  // swallow the user-facing error log below (that log is the whole point).
  try {
    await run?.patchManifest?.({ status: "error" });
  } catch {
    // ignore — fall through to log the original failure
  }
  await session.log(message, { level: "error" });
  return run;
}
