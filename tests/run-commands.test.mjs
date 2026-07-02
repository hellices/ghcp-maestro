import { test } from "node:test";
import assert from "node:assert/strict";

import { showRuns, resumeRun, stopRun } from "../core/run-commands.mjs";

function fakeSession() {
  const logs = [];
  return {
    logs,
    log(msg, opts) {
      logs.push({ msg, level: opts?.level });
    },
  };
}

// --- showRuns ---------------------------------------------------------------

test("showRuns with a runId renders that run's dashboard", async () => {
  const session = fakeSession();
  await showRuns(session, "run-1", {
    readRunProgress: async (id) => ({ id }),
    renderDashboard: (snap) => `DASH ${snap.id}`,
  });
  assert.deepEqual(
    session.logs.map((l) => l.msg),
    ["DASH run-1"],
  );
});

test("showRuns with a runId that has no snapshot reports 'no progress'", async () => {
  const session = fakeSession();
  await showRuns(session, "ghost", { readRunProgress: async () => null });
  assert.match(session.logs[0].msg, /no progress recorded for run 'ghost'/);
});

test("showRuns surfaces a readRunProgress error at error level", async () => {
  const session = fakeSession();
  await showRuns(session, "boom", {
    readRunProgress: async () => {
      throw new Error("disk gone");
    },
  });
  assert.equal(session.logs[0].level, "error");
  assert.match(session.logs[0].msg, /cannot read progress for 'boom': disk gone/);
});

test("showRuns with no arg and no runs reports the empty base dir", async () => {
  const session = fakeSession();
  await showRuns(session, "", {
    listRuns: async () => [],
    defaultBaseDir: () => "/tmp/runs",
  });
  assert.match(session.logs[0].msg, /no runs yet under \/tmp\/runs/);
});

test("showRuns lists recent runs and inlines a live summary for running ones", async () => {
  const session = fakeSession();
  await showRuns(session, "", {
    listRuns: async () => [
      { runId: "r-run", workflow: "task", status: "running", startedAt: 0, args: { task: "x" } },
      { runId: "r-done", workflow: "hello", status: "complete", startedAt: 0 },
    ],
    readRunProgress: async () => ({ ok: true }),
    renderSummary: () => "SUMMARY",
    defaultBaseDir: () => "/tmp/runs",
  });
  const msgs = session.logs.map((l) => l.msg);
  assert.match(msgs[0], /2 recent run\(s\)/);
  assert.ok(msgs.some((m) => m.includes("r-run") && m.includes("workflow=task")));
  assert.ok(msgs.some((m) => m.includes("SUMMARY")));
  assert.ok(msgs.some((m) => m.includes("r-done") && m.includes("status=complete")));
  assert.match(msgs.at(-1), /open a run's live dashboard/);
});

// --- resumeRun --------------------------------------------------------------

test("resumeRun warns when no run id is given", async () => {
  const session = fakeSession();
  await resumeRun(session, "  ", { resolveWorkflowHandler: () => null });
  assert.equal(session.logs[0].level, "warning");
  assert.match(session.logs[0].msg, /requires a run id/);
});

test("resumeRun surfaces openRun failure at error level", async () => {
  const session = fakeSession();
  await resumeRun(session, "r1", {
    resolveWorkflowHandler: () => () => {},
    openRun: async () => {
      throw new Error("missing");
    },
  });
  assert.equal(session.logs[0].level, "error");
  assert.match(session.logs[0].msg, /cannot open run 'r1': missing/);
});

test("resumeRun warns when the workflow is not registered", async () => {
  const session = fakeSession();
  await resumeRun(session, "r1", {
    openRun: async () => ({ manifest: { workflow: "mystery" }, runDir: "/d" }),
    resolveWorkflowHandler: () => null,
  });
  assert.equal(session.logs[0].level, "warning");
  assert.match(session.logs[0].msg, /workflow 'mystery' is not registered/);
});

test("resumeRun flips the run to running and invokes the handler with (session, args, {run})", async () => {
  const session = fakeSession();
  const patches = [];
  const run = {
    manifest: { workflow: "task", args: { task: "go" } },
    runDir: "/d",
    patchManifest: async (p) => patches.push(p),
  };
  let handlerCall = null;
  await resumeRun(session, "r1", {
    openRun: async () => run,
    resolveWorkflowHandler: (name) => {
      assert.equal(name, "task");
      return async (s, args, opts) => {
        handlerCall = { s, args, opts };
      };
    },
  });
  assert.deepEqual(patches, [{ status: "running" }]);
  assert.equal(handlerCall.s, session);
  assert.deepEqual(handlerCall.args, { task: "go" });
  assert.equal(handlerCall.opts.run, run);
});

test("resumeRun routes a handler failure through failRun", async () => {
  const session = fakeSession();
  const run = { manifest: { workflow: "task", args: {} }, runDir: "/d", patchManifest: async () => {} };
  let failed = null;
  await resumeRun(session, "r1", {
    openRun: async () => run,
    resolveWorkflowHandler: () => async () => {
      throw new Error("kaboom");
    },
    failRun: async (s, r, msg) => {
      failed = { r, msg };
    },
  });
  assert.equal(failed.r, run);
  assert.match(failed.msg, /resume failed: kaboom/);
});

// --- stopRun ----------------------------------------------------------------

test("stopRun warns when no run id is given", async () => {
  const session = fakeSession();
  await stopRun(session, "", {});
  assert.equal(session.logs[0].level, "warning");
  assert.match(session.logs[0].msg, /requires a run id/);
});

test("stopRun patches the manifest to stopped with a finish timestamp", async () => {
  const session = fakeSession();
  const patches = [];
  await stopRun(session, "r1", {
    openRun: async () => ({ patchManifest: async (p) => patches.push(p) }),
    now: () => 123,
  });
  assert.deepEqual(patches, [{ status: "stopped", finishedAt: 123 }]);
  assert.match(session.logs[0].msg, /marked r1 as stopped/);
});

test("stopRun surfaces openRun failure at error level", async () => {
  const session = fakeSession();
  await stopRun(session, "r1", {
    openRun: async () => {
      throw new Error("nope");
    },
  });
  assert.equal(session.logs[0].level, "error");
  assert.match(session.logs[0].msg, /cannot stop 'r1': nope/);
});
