import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnAll } from "../extensions/ghcp-maestro/runtime/spawn.mjs";

// An adapter that emits one progress partial then resolves.
function emittingAdapter(partial) {
  return {
    name: "emitting",
    async invoke(spec, ctx) {
      ctx.onProgress?.(partial);
      return { text: `done:${spec.agent}` };
    },
  };
}

test("spawn enriches adapter progress with agent, specId and ts", async () => {
  const seen = [];
  await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    { adapter: emittingAdapter({ state: "streaming", bytes: 12 }), onProgress: (e) => seen.push(e) },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].specId, "e0");
  assert.equal(seen[0].agent, "alpha");
  assert.equal(seen[0].state, "streaming");
  assert.equal(seen[0].bytes, 12);
  assert.equal(typeof seen[0].ts, "number");
});

test("spawn works when no onProgress sink is provided", async () => {
  const res = await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    { adapter: emittingAdapter({ state: "running" }) },
  );
  assert.equal(res.status, "ok");
});

test("an onProgress sink that throws never breaks spawn", async () => {
  const res = await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    {
      adapter: emittingAdapter({ state: "running" }),
      onProgress: () => { throw new Error("monitor blew up"); },
    },
  );
  assert.equal(res.status, "ok");
});

test("spawnAll forwards onProgress to each spec", async () => {
  const seen = [];
  await spawnAll(
    [
      { id: "e0", agent: "alpha", prompt: "p" },
      { id: "e1", agent: "beta", prompt: "p" },
    ],
    { adapter: emittingAdapter({ state: "running" }), onProgress: (e) => seen.push(e.specId) },
  );
  assert.deepEqual(seen.sort(), ["e0", "e1"]);
});
