import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChildEvent,
  subscribeProgress,
  raceAbort,
} from "../core/adapters/standalone-client.mjs";

test("normalizeChildEvent maps streaming deltas to bytes", () => {
  const p = normalizeChildEvent({
    type: "assistant.streaming_delta",
    data: { totalResponseSizeBytes: 4096 },
  });
  assert.deepEqual(p, { state: "streaming", bytes: 4096 });
});

test("normalizeChildEvent maps tool start to a tool state", () => {
  const p = normalizeChildEvent({ type: "tool.execution_start", data: { toolName: "read" } });
  assert.deepEqual(p, { state: "tool", tool: "read" });
});

test("normalizeChildEvent maps usage to a token delta", () => {
  const p = normalizeChildEvent({
    type: "assistant.usage",
    data: { inputTokens: 800, outputTokens: 200 },
  });
  assert.deepEqual(p, { state: "running", tokens: 1000 });
});

test("normalizeChildEvent tolerates partial usage fields", () => {
  assert.deepEqual(
    normalizeChildEvent({ type: "assistant.usage", data: { outputTokens: 50 } }),
    { state: "running", tokens: 50 },
  );
});

test("normalizeChildEvent maps run-ish lifecycle events to running", () => {
  for (const type of [
    "subagent.started",
    "subagent.completed",
    "subagent.failed",
    "assistant.turn_start",
    "tool.execution_progress",
    "tool.execution_complete",
  ]) {
    assert.deepEqual(normalizeChildEvent({ type }), { state: "running" });
  }
});

test("normalizeChildEvent ignores unrelated events", () => {
  assert.equal(normalizeChildEvent({ type: "session.idle" }), null);
  assert.equal(normalizeChildEvent(undefined), null);
});

test("subscribeProgress forwards normalized events and returns an unsub", () => {
  let handler;
  let unsubscribed = false;
  const fakeSession = {
    on(h) { handler = h; return () => { unsubscribed = true; }; },
  };
  const seen = [];
  const unsub = subscribeProgress(fakeSession, (p) => seen.push(p));
  handler({ type: "assistant.streaming_delta", data: { totalResponseSizeBytes: 10 } });
  handler({ type: "session.idle" }); // ignored
  assert.deepEqual(seen, [{ state: "streaming", bytes: 10 }]);
  unsub();
  assert.equal(unsubscribed, true);
});

test("subscribeProgress is a no-op without onProgress or session.on", () => {
  assert.equal(typeof subscribeProgress(null, () => {}), "function");
  assert.equal(typeof subscribeProgress({ on() { return () => {}; } }, null), "function");
});

test("a throwing onProgress never escapes the event handler", () => {
  let handler;
  const fakeSession = { on(h) { handler = h; return () => {}; } };
  subscribeProgress(fakeSession, () => { throw new Error("boom"); });
  assert.doesNotThrow(() => handler({ type: "assistant.turn_start" }));
});

test("raceAbort passes through resolution/rejection when the signal never fires", async () => {
  const ac = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(42), ac.signal), 42);
  await assert.rejects(() => raceAbort(Promise.reject(new Error("inner")), ac.signal), /inner/);
  assert.equal(await raceAbort(Promise.resolve("nosig"), undefined), "nosig");
});

test("raceAbort rejects with the abort reason while the reply is still pending", async () => {
  const ac = new AbortController();
  const pending = new Promise(() => {}); // never settles — simulates in-flight sendAndWait
  const raced = raceAbort(pending, ac.signal);
  const reason = new Error("agent timed out after 5ms");
  reason.name = "TimeoutError";
  ac.abort(reason);
  await assert.rejects(() => raced, /agent timed out after 5ms/);
});

test("raceAbort rejects immediately on an already-aborted signal and swallows the loser", async () => {
  const ac = new AbortController();
  ac.abort(new Error("pre-aborted"));
  let rejectLoser;
  const loser = new Promise((_res, rej) => { rejectLoser = rej; });
  await assert.rejects(() => raceAbort(loser, ac.signal), /pre-aborted/);
  // The detached loser rejection must not surface as an unhandled rejection.
  rejectLoser(new Error("late loser"));
  await new Promise((r) => setTimeout(r, 0));
});
