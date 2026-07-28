// Tests for #20 — agent auto-retry with exponential backoff.
//
// Retry policy contract:
//   - only `error`-status attempts retry; `timeout` and `aborted` never do
//   - backoff sleeps are abortable by the run signal
//   - the result envelope carries `attempts`
//   - default retry count comes from GHCP_MAESTRO_RETRIES (default 1)

import test from "node:test";
import assert from "node:assert/strict";

import { spawn, spawnAll, envRetries, retryBackoffMs } from "../core/spawn.mjs";

/** Adapter that fails the first `failures` invocations, then succeeds. */
function flakyAdapter(failures) {
  let calls = 0;
  return {
    name: "flaky",
    calls: () => calls,
    async invoke(spec) {
      calls += 1;
      if (calls <= failures) throw new Error(`transient failure #${calls}`);
      return { echo: spec.prompt };
    },
  };
}

test("a transient error is retried and succeeds (attempts recorded)", async () => {
  const adapter = flakyAdapter(1);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 1, retryBaseMs: 1 });
  assert.equal(res.status, "ok");
  assert.equal(res.attempts, 2);
  assert.equal(adapter.calls(), 2);
});

test("retries=0 means a single attempt", async () => {
  const adapter = flakyAdapter(1);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 0, retryBaseMs: 1 });
  assert.equal(res.status, "error");
  assert.equal(res.attempts, 1);
  assert.equal(adapter.calls(), 1);
});

test("still error after exhausting retries", async () => {
  const adapter = flakyAdapter(5);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 2, retryBaseMs: 1 });
  assert.equal(res.status, "error");
  assert.equal(res.attempts, 3);
  assert.equal(adapter.calls(), 3);
  assert.match(res.error, /transient failure #3/);
});

test("a successful first attempt reports attempts=1", async () => {
  const adapter = flakyAdapter(0);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 3, retryBaseMs: 1 });
  assert.equal(res.status, "ok");
  assert.equal(res.attempts, 1);
  assert.equal(adapter.calls(), 1);
});

test("timeout is never retried", async () => {
  let calls = 0;
  const adapter = {
    name: "slow",
    async invoke(_spec, ctx) {
      calls += 1;
      await new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      });
    },
  };
  const res = await spawn(
    { prompt: "p", id: "a1", timeoutMs: 20 },
    { adapter, retries: 3, retryBaseMs: 1 },
  );
  assert.equal(res.status, "timeout");
  assert.equal(res.attempts, 1);
  assert.equal(calls, 1);
});

test("abort is never retried", async () => {
  let calls = 0;
  const ac = new AbortController();
  const adapter = {
    name: "abortable",
    async invoke(_spec, ctx) {
      calls += 1;
      ac.abort(new Error("user stop"));
      throw ctx.signal.reason ?? new Error("aborted");
    },
  };
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 3, retryBaseMs: 1, signal: ac.signal });
  assert.equal(res.status, "aborted");
  assert.equal(res.attempts, 1);
  assert.equal(calls, 1);
});

test("abort during backoff resolves promptly as aborted without another attempt", async () => {
  const ac = new AbortController();
  const adapter = flakyAdapter(10);
  const promise = spawn(
    { prompt: "p", id: "a1" },
    { adapter, retries: 3, retryBaseMs: 60_000, signal: ac.signal },
  );
  setTimeout(() => ac.abort(new Error("user stop")), 10);
  const res = await promise;
  assert.equal(res.status, "aborted");
  assert.equal(res.attempts, 1);
  assert.equal(adapter.calls(), 1);
});

test("spawnAll passes retry options through", async () => {
  const adapter = (() => {
    const failedOnce = new Set();
    return {
      name: "flaky-per-spec",
      async invoke(spec) {
        if (!failedOnce.has(spec.id)) {
          failedOnce.add(spec.id);
          throw new Error("transient");
        }
        return { echo: spec.prompt };
      },
    };
  })();
  const results = await spawnAll(
    [
      { prompt: "one", id: "s1" },
      { prompt: "two", id: "s2" },
    ],
    { adapter, retries: 1, retryBaseMs: 1 },
  );
  for (const r of results) {
    assert.equal(r.status, "ok");
    assert.equal(r.attempts, 2);
  }
});

test("persisted agent record includes attempts", async () => {
  const written = [];
  const runHandle = {
    async readAgent() {
      return undefined;
    },
    async writeAgent(rec) {
      written.push(rec);
    },
  };
  const adapter = flakyAdapter(1);
  const res = await spawn({ prompt: "p", id: "a1" }, { adapter, retries: 1, retryBaseMs: 1, runHandle });
  assert.equal(res.status, "ok");
  assert.equal(written.length, 1);
  assert.equal(written[0].attempts, 2);
});

test("envRetries parses GHCP_MAESTRO_RETRIES with a default of 1", () => {
  assert.equal(envRetries({}), 1);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "" }), 1);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "3" }), 3);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "0" }), 0);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "-1" }), 1);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "abc" }), 1);
  assert.equal(envRetries({ GHCP_MAESTRO_RETRIES: "2.5" }), 1);
});

test("retryBackoffMs doubles per attempt with bounded jitter", () => {
  // formula: base * 2^(attempt-1) * (0.5 + 0.5 * rand)
  assert.equal(retryBackoffMs(100, 1, () => 0), 50);
  assert.equal(retryBackoffMs(100, 1, () => 1), 100);
  assert.equal(retryBackoffMs(100, 2, () => 0), 100);
  assert.equal(retryBackoffMs(100, 2, () => 1), 200);
  assert.equal(retryBackoffMs(100, 3, () => 1), 400);
});

test("abort raised during a failing attempt surfaces aborted, not error", async () => {
  // Reviewer finding (PR #25): if the run signal aborts while the adapter is
  // failing (after the error attempt, before the backoff sleep), spawn must
  // report the deliberate outcome — aborted — not the transient error.
  const ac = new AbortController();
  const adapter = {
    name: "fail-then-abort",
    async invoke() {
      ac.abort(); // signal aborts while the attempt is in flight
      throw new Error("transient blip");
    },
  };
  const res = await spawn(
    { prompt: "p", id: "x" },
    { adapter, retries: 2, retryBaseMs: 1, signal: ac.signal },
  );
  assert.equal(res.status, "aborted");
  assert.match(res.error, /transient blip/);
  assert.equal(res.attempts, 1);
});

test("abort landing between a failed attempt and its backoff surfaces aborted", async () => {
  // Reviewer finding (PR #25): if the signal aborts after an attempt was
  // classified as a plain error but before the retry loop consults the signal,
  // spawn must still surface aborted (the deliberate outcome), not error.
  // Two microtask hops land the abort exactly in that gap: hop 1 runs before
  // the catch classification, hop 2 after it but before the loop's check.
  const ac = new AbortController();
  const adapter = {
    name: "fail-then-late-abort",
    async invoke() {
      queueMicrotask(() => queueMicrotask(() => ac.abort()));
      throw new Error("transient blip");
    },
  };
  const res = await spawn(
    { prompt: "p", id: "x" },
    { adapter, retries: 2, retryBaseMs: 5, signal: ac.signal },
  );
  assert.equal(res.status, "aborted");
  assert.match(res.error, /transient blip/);
});
