// Surface-neutral handlers for the run-management commands (/maestros,
// /maestro-resume, /maestro-stop).
//
// These used to live inline in the CLI extension.mjs, which meant they couldn't
// be unit-tested (extension.mjs runs joinSession() at import). They only need a
// duck-typed `session` (with `.log`) plus the run-store collaborators, so they
// move here alongside the rest of the runtime. Every collaborator is injectable
// with a real default, so the CLI calls `showRuns(session, arg)` while tests pass
// fakes.

import { listRuns as realListRuns, readRunProgress as realReadRunProgress, openRun as realOpenRun, defaultBaseDir as realDefaultBaseDir } from "./run-store.mjs";
import { renderDashboard as realRenderDashboard, renderSummary as realRenderSummary } from "./monitor.mjs";
import { failRun as realFailRun } from "./run-flow.mjs";
import { abortRun as realAbortRun } from "./run-registry.mjs";

const RECENT_RUNS_LIMIT = 20;

/**
 * List recent runs, or — when given a runId — render that run's live dashboard.
 *
 * @param {{ log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown> }} session
 * @param {string} arg - a runId, or "" to list recent runs
 * @param {{
 *   listRuns?: typeof realListRuns,
 *   readRunProgress?: typeof realReadRunProgress,
 *   renderDashboard?: typeof realRenderDashboard,
 *   renderSummary?: typeof realRenderSummary,
 *   defaultBaseDir?: typeof realDefaultBaseDir,
 * }} [deps]
 */
export async function showRuns(session, arg, deps = {}) {
  const {
    listRuns = realListRuns,
    readRunProgress = realReadRunProgress,
    renderDashboard = realRenderDashboard,
    renderSummary = realRenderSummary,
    defaultBaseDir = realDefaultBaseDir,
  } = deps;

  const runId = (arg ?? "").trim();
  if (runId) {
    let snap;
    try {
      snap = await readRunProgress(runId);
    } catch (err) {
      await session.log(
        `ghcp-maestro: cannot read progress for '${runId}': ${err?.message ?? err}`,
        { level: "error" },
      );
      return;
    }
    if (!snap) {
      await session.log(`ghcp-maestro: no progress recorded for run '${runId}' (yet)`);
      return;
    }
    await session.log(renderDashboard(snap));
    return;
  }

  const runs = await listRuns({ limit: RECENT_RUNS_LIMIT });
  if (runs.length === 0) {
    await session.log(`ghcp-maestro: no runs yet under ${defaultBaseDir()}`);
    return;
  }
  await session.log(`ghcp-maestro: ${runs.length} recent run(s) (newest first):`);
  for (const m of runs) {
    const argsPreview = m.args ? JSON.stringify(m.args).slice(0, 80) : "";
    await session.log(
      `  ${m.runId}  workflow=${m.workflow}  status=${m.status}  started=${new Date(m.startedAt).toISOString()}${argsPreview ? `  args=${argsPreview}` : ""}`,
    );
    if (m.status === "running") {
      const snap = await readRunProgress(m.runId).catch(() => undefined);
      if (snap) await session.log(`      ${renderSummary(snap)}`);
    }
  }
  await session.log("ghcp-maestro: open a run's live dashboard with /maestros <runId>");
}

/**
 * Resume a run by id: reopen its manifest, resolve its workflow handler, flip it
 * back to running, and re-invoke the handler (cached agent results are reused).
 * `resolveWorkflowHandler` is surface-composed (built-ins + saved workflows), so
 * it has no default and must be supplied.
 *
 * @param {{ log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown> }} session
 * @param {string} runId
 * @param {{
 *   resolveWorkflowHandler: (workflow: string) => ((session: object, args: unknown, opts: object) => Promise<unknown>) | null,
 *   openRun?: typeof realOpenRun,
 *   failRun?: typeof realFailRun,
 * }} deps
 */
export async function resumeRun(session, runId, deps) {
  const { resolveWorkflowHandler, openRun = realOpenRun, failRun = realFailRun } = deps;
  const id = (runId ?? "").trim();
  if (!id) {
    await session.log("ghcp-maestro: /maestro-resume requires a run id", { level: "warning" });
    return;
  }
  let run;
  try {
    run = await openRun(id);
  } catch (err) {
    await session.log(`ghcp-maestro: cannot open run '${id}': ${err?.message ?? err}`, {
      level: "error",
    });
    return;
  }
  const wf = resolveWorkflowHandler(run.manifest.workflow);
  if (!wf) {
    await session.log(
      `ghcp-maestro: workflow '${run.manifest.workflow}' is not registered; can't resume`,
      { level: "warning" },
    );
    return;
  }
  await session.log(
    `ghcp-maestro: resuming ${id} (workflow=${run.manifest.workflow}, dir=${run.runDir})`,
  );
  await run.patchManifest({ status: "running" });
  try {
    await wf(session, run.manifest.args, { run });
  } catch (err) {
    await failRun(session, run, `ghcp-maestro: resume failed: ${err?.message ?? err}`);
  }
}

/**
 * Mark a run as stopped. When this process owns the run's AbortController
 * (i.e. the run was started here), its in-flight agents are aborted too;
 * otherwise the stop is manifest-only and in-flight agents in other processes
 * are unaffected.
 *
 * @param {{ log: (msg: string, opts?: { level?: string }) => unknown | Promise<unknown> }} session
 * @param {string} runId
 * @param {{ openRun?: typeof realOpenRun, abortRun?: typeof realAbortRun, now?: () => number }} [deps]
 */
export async function stopRun(session, runId, deps = {}) {
  const { openRun = realOpenRun, abortRun = realAbortRun, now = () => Date.now() } = deps;
  const id = (runId ?? "").trim();
  if (!id) {
    await session.log("ghcp-maestro: /maestro-stop requires a run id", { level: "warning" });
    return;
  }
  let aborted = false;
  try {
    const run = await openRun(id);
    // Abort first: stopping the in-flight token burn is the command's primary
    // effect, so a manifest write failure below must never skip it.
    aborted = abortRun(id);
    await run.patchManifest({ status: "stopped", finishedAt: now() });
    await session.log(
      `ghcp-maestro: marked ${id} as stopped${aborted ? " and signalled its in-flight agents to abort" : " (no in-flight agents owned by this process)"}`,
    );
  } catch (err) {
    await session.log(
      `ghcp-maestro: cannot ${aborted ? "persist stop for" : "stop"} '${id}': ${err?.message ?? err}`,
      { level: "error" },
    );
  }
}
