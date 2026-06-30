import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorEnabled } from "../extensions/ghcp-maestro/runtime/env-flags.mjs";

test("monitoring is on by default", () => {
  assert.equal(monitorEnabled({}), true);
});

test("GHCP_MAESTRO_NO_MONITOR opts out", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: v }), false, v);
  }
});

test("a non-truthy opt-out value leaves monitoring on", () => {
  assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: "0" }), true);
  assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: "" }), true);
});
