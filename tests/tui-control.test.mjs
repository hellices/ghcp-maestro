import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../core/run-store.mjs";
import { createRunRegistry } from "../core/run-registry.mjs";
import { spawnAll } from "../core/spawn.mjs";
import {
  requestAgentControl,
  consumeControlRequests,
  applyControlRequests,
} from "../core/tui-control.mjs";

async function freshBase() {
  return mkdtemp(join(tmpdir(), "ghcp-maestro-ctl-"));
}

/** Adapter that hangs until its signal aborts. */
function hangingAdapter() {
  return {
    name: "hang",
    invoke(_spec, { signal }) {
      return new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

test("spawnAll getAgentSignal: aborting one agent leaves siblings running", async () => {
  const registry = createRunRegistry();
  const adapter = {
    name: "mixed",
    invoke(spec, { signal }) {
      if (spec.agent === "fast") return Promise.resolve({ text: "done" });
      return new Promise((_r, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const pending = spawnAll(
    [
      { id: "slow", agent: "slow", prompt: "p" },
      { id: "fast", agent: "fast", prompt: "p" },
    ],
    {
      adapter,
      retries: 0,
      getAgentSignal: (id) => registry.ensureAgentController("run-1", id).signal,
    },
  );
  // let the fast agent settle, then stop only the slow one
  await new Promise((r) => setImmediate(r));
  assert.equal(registry.abortAgent("run-1", "slow"), true);
  const results = await pending;
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.slow.status, "aborted");
  assert.equal(byId.fast.status, "ok");
});

test("run-level signal still aborts every agent when composed with agent signals", async () => {
  const registry = createRunRegistry();
  const runController = new AbortController();
  const pending = spawnAll(
    [
      { id: "x", agent: "x", prompt: "p" },
      { id: "y", agent: "y", prompt: "p" },
    ],
    {
      adapter: hangingAdapter(),
      retries: 0,
      signal: runController.signal,
      getAgentSignal: (id) => registry.ensureAgentController("run-1", id).signal,
    },
  );
  await new Promise((r) => setImmediate(r));
  runController.abort(new Error("run stopped"));
  const results = await pending;
  assert.ok(results.every((r) => r.status === "aborted"));
});

test("requestAgentControl / consumeControlRequests round-trip and drain", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    assert.deepEqual(await consumeControlRequests(run.runDir), [], "empty channel");

    await requestAgentControl(run.runDir, { agentId: "a1", action: "stop" });
    await requestAgentControl(run.runDir, { agentId: "a2", action: "stop" });

    const requests = await consumeControlRequests(run.runDir);
    assert.equal(requests.length, 2);
    assert.deepEqual(new Set(requests.map((r) => r.agentId)), new Set(["a1", "a2"]));
    assert.ok(requests.every((r) => r.action === "stop"));

    assert.deepEqual(await consumeControlRequests(run.runDir), [], "consumed requests are drained");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("requestAgentControl rejects unsafe agent ids", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    await assert.rejects(() => requestAgentControl(run.runDir, { agentId: "../x", action: "stop" }));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("applyControlRequests aborts the addressed agents through the registry", async () => {
  const registry = createRunRegistry();
  const a1 = registry.ensureAgentController("run-1", "a1");
  const a2 = registry.ensureAgentController("run-1", "a2");
  const applied = applyControlRequests(
    [
      { agentId: "a1", action: "stop" },
      { agentId: "ghost", action: "stop" },
      { agentId: "a2", action: "unknown-action" },
    ],
    { runId: "run-1", registry },
  );
  assert.equal(a1.signal.aborted, true);
  assert.equal(a2.signal.aborted, false, "unknown actions are ignored");
  assert.deepEqual(applied, ["a1"], "only live stops are reported as applied");
});

test("consumeControlRequests ignores foreign files and tolerates a missing dir", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    await requestAgentControl(run.runDir, { agentId: "a1", action: "stop" });
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(run.runDir, "control"), { recursive: true });
    await writeFile(join(run.runDir, "control", "junk.txt"), "not json", "utf8");
    await writeFile(join(run.runDir, "control", "bad.json"), "{torn", "utf8");
    const requests = await consumeControlRequests(run.runDir);
    assert.deepEqual(requests.map((r) => r.agentId), ["a1"]);
    // junk stays untouched, consumed json is gone
    const left = await readdir(join(run.runDir, "control"));
    assert.ok(left.includes("junk.txt"));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
