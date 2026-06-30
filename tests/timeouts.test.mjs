import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt } from "../extensions/ghcp-maestro/runtime/timeouts.mjs";

test("envInt returns the fallback when the var is unset or blank", () => {
  assert.equal(envInt("X", 120_000, {}), 120_000);
  assert.equal(envInt("X", 120_000, { X: "" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "   " }), 120_000);
});

test("envInt parses a positive integer override", () => {
  assert.equal(envInt("X", 120_000, { X: "300000" }), 300_000);
  assert.equal(envInt("X", 120_000, { X: " 45000 " }), 45_000);
});

test("envInt ignores non-numeric, zero, or negative values (keeps fallback)", () => {
  assert.equal(envInt("X", 120_000, { X: "abc" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "0" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "-5000" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "NaN" }), 120_000);
});

test("envInt rejects non-integer values (ms timeouts must be whole)", () => {
  assert.equal(envInt("X", 120_000, { X: "12.5" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "300000.0001" }), 120_000);
  assert.equal(envInt("X", 120_000, { X: "1e3" }), 1_000); // exponent → integer value is fine
});

test("the research and probe tiers read their own env vars", () => {
  // The two exported tiers map to distinct knobs (research vs diagnostic).
  assert.equal(envInt("GHCP_MAESTRO_TIMEOUT_MS", 600_000, {}), 600_000);
  assert.equal(
    envInt("GHCP_MAESTRO_TIMEOUT_MS", 600_000, { GHCP_MAESTRO_TIMEOUT_MS: "900000" }),
    900_000,
  );
  assert.equal(envInt("GHCP_MAESTRO_TIMEOUT_PROBE_MS", 60_000, {}), 60_000);
  assert.equal(
    envInt("GHCP_MAESTRO_TIMEOUT_PROBE_MS", 60_000, { GHCP_MAESTRO_TIMEOUT_PROBE_MS: "5000" }),
    5_000,
  );
});
