import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinWorkflows } from "../core/builtin-workflows.mjs";

// A deterministic in-process adapter: the plan agent returns a valid 3-entry
// JSON plan; every other agent echoes a per-agent line. Lets the extracted
// workflows run end-to-end under `node --test` with no live Copilot CLI.
function testAdapter() {
  return {
    name: "test",
    async invoke(spec) {
      if (spec.agent === "plan") {
        return {
          text: JSON.stringify([
            { agent: "a", prompt: "pa" },
            { agent: "b", prompt: "pb" },
            { agent: "c", prompt: "pc" },
          ]),
        };
      }
      return { text: `out-${spec.agent}` };
    },
  };
}

/** Fake host session collecting logs; no elicitation capability (non-interactive). */
function fakeSession() {
  const logs = [];
  return {
    logs,
    capabilities: {},
    log: async (msg) => {
      logs.push(String(msg));
    },
  };
}

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-wf-"));
  const prevData = process.env.GHCP_MAESTRO_DATA_DIR;
  const prevMon = process.env.GHCP_MAESTRO_NO_MONITOR;
  process.env.GHCP_MAESTRO_DATA_DIR = dir;
  process.env.GHCP_MAESTRO_NO_MONITOR = "1";
  try {
    return await fn();
  } finally {
    if (prevData === undefined) delete process.env.GHCP_MAESTRO_DATA_DIR;
    else process.env.GHCP_MAESTRO_DATA_DIR = prevData;
    if (prevMon === undefined) delete process.env.GHCP_MAESTRO_NO_MONITOR;
    else process.env.GHCP_MAESTRO_NO_MONITOR = prevMon;
    await rm(dir, { recursive: true, force: true });
  }
}

test("hello workflow runs both phases and completes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runHelloWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runHelloWorkflow(session);
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /hello workflow complete \(4 agents across 2 phases\)/.test(l)));
    assert.ok(session.logs.some((l) => /phase=explore agents=3/.test(l)));
    assert.ok(session.logs.some((l) => /phase=synth agents=1/.test(l)));
  });
});

test("brainstorm workflow runs 4 lenses + synth and completes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runBrainstormWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runBrainstormWorkflow(session, "a test topic");
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /phase=explore agents=4/.test(l)));
    assert.ok(session.logs.some((l) => /brainstorm complete — 5 agents across 2 phases/.test(l)));
  });
});

test("task workflow plans, fans out, and synthesizes", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "complete");
    assert.ok(session.logs.some((l) => /plan produced 3 subtask\(s\): a, b, c/.test(l)));
    assert.ok(session.logs.some((l) => /phase=explore agents=3/.test(l)));
    assert.ok(session.logs.some((l) => /task workflow complete — 5 agents across 3 phases/.test(l)));
  });
});

test("task workflow fails cleanly when the plan is unparseable", async () => {
  await withTempDataDir(async () => {
    const session = fakeSession();
    // Adapter whose plan agent never returns valid JSON → plan + retry both fail.
    const badAdapter = () => ({
      name: "bad",
      async invoke() {
        return { text: "not json at all" };
      },
    });
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: badAdapter });
    const run = await runTaskWorkflow(session, "do the thing");
    assert.equal(run.manifest.status, "error");
    assert.ok(session.logs.some((l) => /plan retry also unparseable/.test(l)));
  });
});
