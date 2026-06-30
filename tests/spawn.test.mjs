import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spawn,
  spawnAll,
  dummyAdapter,
  GLOBAL_AGENT_CAP,
  DEFAULT_CONCURRENCY,
} from "../extensions/ghcp-maestro/runtime/spawn.mjs";

test("spawn returns ok envelope on success", async () => {
  const r = await spawn(
    { prompt: "hello", agent: "explore" },
    { adapter: dummyAdapter },
  );
  assert.equal(r.status, "ok");
  assert.equal(r.output.echo, "hello");
  assert.equal(r.output.agent, "explore");
  assert.ok(r.startedAt <= r.finishedAt);
  assert.match(r.id, /^agent-/);
});

test("spawn captures failures as error status", async () => {
  const r = await spawn(
    { prompt: "x", input: { fail: true } },
    { adapter: dummyAdapter },
  );
  assert.equal(r.status, "error");
  assert.match(r.error, /forced failure/);
});

test("spawn returns timeout status when adapter exceeds timeoutMs", async () => {
  const r = await spawn(
    { prompt: "slow", timeoutMs: 20, input: { delayMs: 200 } },
    { adapter: dummyAdapter },
  );
  assert.equal(r.status, "timeout");
});

test("spawnAll preserves order and runs under cap", async () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({
    prompt: `p${i}`,
    input: { delayMs: 10 },
  }));
  const t0 = Date.now();
  const results = await spawnAll(specs, { adapter: dummyAdapter, concurrency: 4 });
  const elapsed = Date.now() - t0;

  assert.equal(results.length, 12);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(results[i].status, "ok");
    assert.equal(results[i].output.echo, `p${i}`);
  }
  // 12 tasks × 10ms / 4 concurrency ≈ 30ms (plus scheduling slack).
  assert.ok(elapsed >= 25, `elapsed too small: ${elapsed}ms`);
  assert.ok(elapsed < 200, `elapsed too large: ${elapsed}ms`);
});

test("spawnAll reflects per-spec failures without throwing", async () => {
  const specs = [
    { prompt: "a" },
    { prompt: "b", input: { fail: true } },
    { prompt: "c" },
  ];
  const results = await spawnAll(specs, { adapter: dummyAdapter, concurrency: 2 });
  assert.deepEqual(
    results.map((r) => r.status),
    ["ok", "error", "ok"],
  );
});

test("spawnAll enforces GLOBAL_AGENT_CAP", async () => {
  const specs = new Array(GLOBAL_AGENT_CAP + 1).fill({ prompt: "x" });
  await assert.rejects(
    () => spawnAll(specs, { adapter: dummyAdapter, concurrency: 16 }),
    /exceeds global cap/,
  );
});

test("DEFAULT_CONCURRENCY matches REQUIREMENTS §4.4", () => {
  assert.equal(DEFAULT_CONCURRENCY, 16);
  assert.equal(GLOBAL_AGENT_CAP, 1000);
});
