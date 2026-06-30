import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChildEvent,
  subscribeProgress,
} from "../extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs";

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
  for (const type of ["subagent.started", "assistant.turn_start", "tool.execution_complete"]) {
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
