// Tests for #14 — budget enforcement in spawn/spawnAll.
//
// Contract: when a run's budget tracker reports exceeded, agents not yet
// scheduled are skipped (adapter NOT invoked, status "aborted") while agents
// already in flight finish normally. Token counts flow into the tracker from
// the adapter's onProgress events.

import test from "node:test";
import assert from "node:assert/strict";

import { spawn, spawnAll } from "../core/spawn.mjs";
import { createBudgetTracker } from "../core/budget.mjs";

/** Adapter that reports `tokensPerCall` usage via onProgress, then succeeds. */
function tokenAdapter(tokensPerCall) {
  let calls = 0;
  return {
    name: "token",
    calls: () => calls,
    async invoke(spec, ctx) {
      calls += 1;
      ctx.onProgress?.({ state: "running", tokens: tokensPerCall });
      return { echo: spec.prompt };
    },
  };
}

test("an exceeded budget skips scheduling: adapter not invoked, status aborted", async () => {
  const budget = createBudgetTracker(100);
  budget.add(101);
  const adapter = tokenAdapter(10);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, budget, retries: 0 });
  assert.equal(res.status, "aborted");
  assert.match(res.error, /budget/);
  assert.equal(adapter.calls(), 0);
});

test("onProgress token events accumulate into the budget tracker", async () => {
  const budget = createBudgetTracker(1000);
  const adapter = tokenAdapter(250);
  await spawn({ prompt: "p", id: "a1" }, { adapter, budget, retries: 0 });
  assert.equal(budget.used(), 250);
});

test("budget accumulates even without a caller onProgress sink", async () => {
  const budget = createBudgetTracker(1000);
  const adapter = tokenAdapter(300);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, budget, retries: 0 });
  assert.equal(res.status, "ok");
  assert.equal(budget.used(), 300);
});

test("spawnAll soft-stops: in-flight finishes, later agents skip once exceeded", async () => {
  const budget = createBudgetTracker(100);
  const adapter = tokenAdapter(150); // first agent alone blows the budget
  const results = await spawnAll(
    [
      { prompt: "one", id: "s1" },
      { prompt: "two", id: "s2" },
      { prompt: "three", id: "s3" },
    ],
    { adapter, budget, concurrency: 1, retries: 0 },
  );
  assert.equal(results[0].status, "ok");
  assert.equal(results[1].status, "aborted");
  assert.equal(results[2].status, "aborted");
  assert.equal(adapter.calls(), 1);
});

test("a budget-skipped agent is persisted (resumable) and not replayed as ok", async () => {
  const written = [];
  const runHandle = {
    async readAgent() {
      return undefined;
    },
    async writeAgent(rec) {
      written.push(rec);
    },
  };
  const budget = createBudgetTracker(10);
  budget.add(11);
  const adapter = tokenAdapter(1);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, budget, runHandle, retries: 0 });
  assert.equal(res.status, "aborted");
  assert.equal(written.length, 1);
  assert.equal(written[0].status, "aborted");
});

test("cached ok results replay even when the budget is exceeded", async () => {
  const runHandle = {
    async readAgent() {
      return { id: "a1", spec: { prompt: "p" }, status: "ok", output: { text: "done" } };
    },
    async writeAgent() {},
  };
  const budget = createBudgetTracker(10);
  budget.add(11);
  const adapter = tokenAdapter(1);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, budget, runHandle, retries: 0 });
  assert.equal(res.status, "ok");
  assert.equal(res.cached, true);
  assert.equal(adapter.calls(), 0);
});
