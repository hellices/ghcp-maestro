import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  openRun,
  listRuns,
  readRunProgress,
  readJson,
  writeJsonAtomic,
} from "../core/run-store.mjs";
import { spawnAll } from "../core/spawn.mjs";

async function freshBase() {
  return mkdtemp(join(tmpdir(), "ghcp-maestro-test-"));
}

test("createRun writes manifest, listRuns returns it newest-first", async () => {
  const baseDir = await freshBase();
  try {
    const a = await createRun({ workflow: "wf-a", baseDir, args: { x: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createRun({ workflow: "wf-b", baseDir, args: ["y"] });

    const all = await listRuns({ baseDir });
    assert.equal(all.length, 2);
    assert.equal(all[0].runId, b.runId);
    assert.equal(all[1].runId, a.runId);
    assert.deepEqual(all[0].args, ["y"]);
    assert.equal(all[0].status, "running");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeAgent / readAgent round-trip", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "wf", baseDir });
    await run.writeAgent({
      agentId: "alpha",
      spec: { prompt: "p", agent: "x" },
      status: "ok",
      output: { text: "hi" },
      startedAt: 1,
      finishedAt: 2,
    });
    const read = await run.readAgent("alpha");
    assert.equal(read.status, "ok");
    assert.equal(read.output.text, "hi");
    const reopened = await openRun(run.runId, { baseDir });
    const again = await reopened.readAgent("alpha");
    assert.equal(again.status, "ok");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeProgress / readProgress round-trips a snapshot", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    const snap = {
      label: "x explore",
      agents: [],
      done: 0,
      total: 2,
      maxElapsedMs: 0,
      totalTokens: 0,
      updatedAt: 123,
    };
    await run.writeProgress(snap);
    assert.deepEqual(await run.readProgress(), snap);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readProgress is undefined before any write", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    assert.equal(await run.readProgress(), undefined);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeProgress serializes a fire-and-forget burst; the last-issued snapshot wins", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    // Mirror the monitor's settle×N + flush sink: a burst of un-awaited writes to
    // the same file, awaiting only the last. The first write carries a large
    // payload so its atomic rename takes the longest to land; WITHOUT
    // serialization that stale write would win the race and leave progress.json
    // on updatedAt:1. Serialization makes issue-order == completion-order, so the
    // final updatedAt:4 snapshot must win — deterministically, regardless of I/O
    // timing. (Verified: the unchained impl fails this 10/10; chained passes 10/10.)
    const big = "x".repeat(8 * 1024 * 1024);
    run.writeProgress({ done: 0, total: 3, updatedAt: 1, blob: big }).catch(() => {});
    run.writeProgress({ done: 1, total: 3, updatedAt: 2 }).catch(() => {});
    run.writeProgress({ done: 2, total: 3, updatedAt: 3 }).catch(() => {});
    await run.writeProgress({ done: 3, total: 3, updatedAt: 4 });
    const got = await run.readProgress();
    assert.equal(got.done, 3);
    assert.equal(got.updatedAt, 4);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readRunProgress reads a run's progress by id", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "task", baseDir });
    await run.writeProgress({ done: 1, total: 3 });
    const got = await readRunProgress(run.runId, { baseDir });
    assert.equal(got.done, 1);
    assert.equal(got.total, 3);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readRunProgress is undefined for an unknown run", async () => {
  const baseDir = await freshBase();
  try {
    assert.equal(await readRunProgress("run-does-not-exist", { baseDir }), undefined);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readRunProgress rejects an unsafe runId", async () => {
  const baseDir = await freshBase();
  try {
    await assert.rejects(() => readRunProgress("../escape", { baseDir }));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic does not leave a partial file on success", async () => {
  const baseDir = await freshBase();
  try {
    const target = join(baseDir, "a", "b.json");
    await writeJsonAtomic(target, { ok: true });
    const back = await readJson(target);
    assert.deepEqual(back, { ok: true });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic overwrites an existing target (atomic replace)", async () => {
  const baseDir = await freshBase();
  try {
    const target = join(baseDir, "m.json");
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    await writeJsonAtomic(target, { v: 3 });
    assert.deepEqual(await readJson(target), { v: 3 });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("openRun rejects unsafe runIds (path traversal)", async () => {
  for (const bad of ["../escape", "..", "a/b", "a\\b", "", "x\0y"]) {
    await assert.rejects(
      () => openRun(bad, { baseDir: "/tmp/ghcp-maestro-nonexistent" }),
      /unsafe runId|non-empty string/,
    );
  }
});

test("spawn with runHandle persists and reuses cached results", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "wf", baseDir });
    let calls = 0;
    const counting = {
      name: "counting",
      async invoke(spec) {
        calls += 1;
        return { echo: spec.prompt };
      },
    };
    const specs = [
      { id: "one", prompt: "a" },
      { id: "two", prompt: "b" },
    ];
    const first = await spawnAll(specs, { adapter: counting, runHandle: run });
    assert.equal(calls, 2);
    assert.equal(first[0].status, "ok");

    // Second run with same handle/specs should hit cache for both.
    const second = await spawnAll(specs, { adapter: counting, runHandle: run });
    assert.equal(calls, 2, "no new invocations expected on cache hit");
    assert.equal(second[0].output.echo, "a");
    assert.equal(second[0].cached, true);
    assert.equal(second[1].cached, true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("spawn re-runs cached failed/timeout records on resume (only ok replays)", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "wf", baseDir });
    let calls = 0;
    let failing = true;
    const flaky = {
      name: "flaky",
      async invoke(spec) {
        calls += 1;
        if (failing) throw new Error("boom");
        return { echo: spec.prompt };
      },
    };
    const spec = { id: "one", prompt: "a" };
    // retries: 0 isolates the resume/cache contract from spawn's auto-retry.
    const first = await spawnAll([spec], { adapter: flaky, runHandle: run, retries: 0 });
    assert.equal(first[0].status, "error");
    assert.equal(calls, 1);

    // Resume: the cached error record must NOT be replayed — the agent reruns.
    failing = false;
    const second = await spawnAll([spec], { adapter: flaky, runHandle: run, retries: 0 });
    assert.equal(calls, 2, "failed record must re-invoke the adapter");
    assert.equal(second[0].status, "ok");
    assert.notEqual(second[0].cached, true);

    // Third pass: now the ok record IS served from cache.
    const third = await spawnAll([spec], { adapter: flaky, runHandle: run });
    assert.equal(calls, 2, "ok record must be served from cache");
    assert.equal(third[0].cached, true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("spawn without spec.id ignores cache", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "wf", baseDir });
    let calls = 0;
    const adapter = {
      name: "x",
      async invoke() {
        calls += 1;
        return null;
      },
    };
    await spawnAll([{ prompt: "p" }], { adapter, runHandle: run });
    await spawnAll([{ prompt: "p" }], { adapter, runHandle: run });
    assert.equal(calls, 2, "no spec.id means no caching");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("run.complete updates manifest status", async () => {
  const baseDir = await freshBase();
  try {
    const run = await createRun({ workflow: "wf", baseDir });
    await run.complete();
    const all = await listRuns({ baseDir });
    assert.equal(all[0].status, "complete");
    assert.ok(all[0].finishedAt > 0);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
