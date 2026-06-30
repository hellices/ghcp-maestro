import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchEnvTriggers } from "../extensions/ghcp-maestro/runtime/probes.mjs";

const flush = () => new Promise((r) => setTimeout(r, 0));

test("dispatchEnvTriggers fires only triggers whose env var is set and non-empty", async () => {
  const fired = [];
  const env = { A: "alpha", B: "", C: "   ", D: "delta" };
  dispatchEnvTriggers(env, [
    { env: "A", label: "a", run: (v) => fired.push(["A", v]) },
    { env: "B", label: "b", run: (v) => fired.push(["B", v]) },
    { env: "C", label: "c", run: (v) => fired.push(["C", v]) },
    { env: "D", label: "d", run: (v) => fired.push(["D", v]) },
    { env: "MISSING", label: "m", run: (v) => fired.push(["MISSING", v]) },
  ]);
  await flush();
  assert.deepEqual(fired, [["A", "alpha"], ["D", "delta"]]);
});

test("dispatchEnvTriggers passes the trimmed value to the handler", async () => {
  let got = null;
  dispatchEnvTriggers({ X: "  hello world  " }, [
    { env: "X", label: "x", run: (v) => { got = v; } },
  ]);
  await flush();
  assert.equal(got, "hello world");
});

test("dispatchEnvTriggers routes a rejected handler to onError with its label", async () => {
  const errors = [];
  dispatchEnvTriggers({ X: "boom" }, [
    { env: "X", label: "x-probe", run: async () => { throw new Error("nope"); } },
  ], { onError: (label, err) => errors.push([label, err.message]) });
  await flush();
  assert.deepEqual(errors, [["x-probe", "nope"]]);
});

test("dispatchEnvTriggers routes a synchronously-thrown handler to onError", async () => {
  const errors = [];
  dispatchEnvTriggers({ X: "boom" }, [
    { env: "X", label: "sync", run: () => { throw new Error("sync-throw"); } },
  ], { onError: (label, err) => errors.push([label, err.message]) });
  await flush();
  assert.deepEqual(errors, [["sync", "sync-throw"]]);
});

test("dispatchEnvTriggers tolerates a missing onError when a handler rejects", async () => {
  // Must not throw synchronously and must not leave an unhandled rejection.
  dispatchEnvTriggers({ X: "boom" }, [
    { env: "X", label: "x", run: async () => { throw new Error("swallowed"); } },
  ]);
  await flush();
  assert.ok(true);
});
