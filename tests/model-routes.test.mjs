import { test } from "node:test";
import assert from "node:assert/strict";

import { parseModelRoutes, envModelRoutes, resolveModel } from "../core/model-routes.mjs";

// --- parseModelRoutes ---------------------------------------------------------

test("parseModelRoutes parses a JSON object of string routes", () => {
  assert.deepEqual(parseModelRoutes('{"explore:*":"fast","synth":"premium"}'), {
    "explore:*": "fast",
    synth: "premium",
  });
});

test("parseModelRoutes passes plain objects through", () => {
  assert.deepEqual(parseModelRoutes({ "*": "m" }), { "*": "m" });
});

test("parseModelRoutes returns null for invalid input", () => {
  assert.equal(parseModelRoutes(undefined), null);
  assert.equal(parseModelRoutes(""), null);
  assert.equal(parseModelRoutes("  "), null);
  assert.equal(parseModelRoutes("not json"), null);
  assert.equal(parseModelRoutes("[1,2]"), null);
  assert.equal(parseModelRoutes("42"), null);
  assert.equal(parseModelRoutes("null"), null);
});

test("parseModelRoutes drops non-string and empty values", () => {
  assert.deepEqual(parseModelRoutes('{"a":"m","b":42,"c":""}'), { a: "m" });
  assert.equal(parseModelRoutes('{"b":42}'), null);
});

test("envModelRoutes reads GHCP_MAESTRO_MODEL_ROUTES", () => {
  assert.deepEqual(envModelRoutes({ GHCP_MAESTRO_MODEL_ROUTES: '{"plan":"big"}' }), {
    plan: "big",
  });
  assert.equal(envModelRoutes({}), null);
});

// --- resolveModel ---------------------------------------------------------------

test("resolveModel matches exact labels", () => {
  const routes = { synth: "premium" };
  assert.equal(resolveModel("synth", routes), "premium");
  assert.equal(resolveModel("plan", routes), undefined);
});

test("resolveModel matches glob patterns and * fallback", () => {
  const routes = { "explore:*": "fast", "*": "default" };
  assert.equal(resolveModel("explore:my-agent", routes), "fast");
  assert.equal(resolveModel("synth", routes), "default");
});

test("resolveModel is first-match-wins in insertion order", () => {
  const routes = { "explore:special": "premium", "explore:*": "fast" };
  assert.equal(resolveModel("explore:special", routes), "premium");
  assert.equal(resolveModel("explore:other", routes), "fast");
});

test("resolveModel escapes regex metacharacters in patterns", () => {
  const routes = { "explore:a.b": "m" };
  assert.equal(resolveModel("explore:a.b", routes), "m");
  assert.equal(resolveModel("explore:aXb", routes), undefined);
});

test("resolveModel returns undefined for null/empty routes", () => {
  assert.equal(resolveModel("plan", null), undefined);
  assert.equal(resolveModel("plan", undefined), undefined);
});

test("parseModelRoutes trims padded keys and values so they match at resolve time", () => {
  const routes = parseModelRoutes({ " synth ": " premium " });
  assert.deepEqual(routes, { synth: "premium" });
  assert.equal(resolveModel("synth", routes), "premium");
});
