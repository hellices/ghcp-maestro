// Tests for #14 — token budget parsing/tracking + run-size estimate.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseBudgetTokens,
  envBudgetTokens,
  createBudgetTracker,
  estimateRunSize,
  envLargeRunAgents,
} from "../core/budget.mjs";

test("parseBudgetTokens parses plain integers and k/m suffixes", () => {
  assert.equal(parseBudgetTokens("120000"), 120000);
  assert.equal(parseBudgetTokens("500k"), 500_000);
  assert.equal(parseBudgetTokens("500K"), 500_000);
  assert.equal(parseBudgetTokens("2m"), 2_000_000);
  assert.equal(parseBudgetTokens("1.5M"), 1_500_000);
  assert.equal(parseBudgetTokens(" 10k "), 10_000);
});

test("parseBudgetTokens rejects invalid or non-positive values", () => {
  for (const bad of ["", "0", "-5", "abc", "5x", "k", null, undefined, "1 000"]) {
    assert.equal(parseBudgetTokens(bad), null, `input=${bad}`);
  }
});

test("envBudgetTokens reads GHCP_MAESTRO_BUDGET_TOKENS (default null = no cap)", () => {
  assert.equal(envBudgetTokens({}), null);
  assert.equal(envBudgetTokens({ GHCP_MAESTRO_BUDGET_TOKENS: "" }), null);
  assert.equal(envBudgetTokens({ GHCP_MAESTRO_BUDGET_TOKENS: "500k" }), 500_000);
  assert.equal(envBudgetTokens({ GHCP_MAESTRO_BUDGET_TOKENS: "junk" }), null);
});

test("budget tracker accumulates and reports exceeded", () => {
  const b = createBudgetTracker(1000);
  assert.equal(b.limit, 1000);
  assert.equal(b.exceeded(), false);
  b.add(400);
  b.add(500);
  assert.equal(b.used(), 900);
  assert.equal(b.exceeded(), false);
  b.add(101);
  assert.equal(b.exceeded(), true);
});

test("budget tracker treats hitting the cap exactly as exceeded", () => {
  const b = createBudgetTracker(1000);
  b.add(1000);
  assert.equal(b.used(), 1000);
  assert.equal(b.exceeded(), true);
});

test("budget tracker without a limit never exceeds", () => {
  const b = createBudgetTracker(null);
  b.add(10_000_000);
  assert.equal(b.exceeded(), false);
  assert.equal(b.limit, null);
});

test("budget tracker ignores non-numeric adds", () => {
  const b = createBudgetTracker(100);
  b.add(undefined);
  b.add(NaN);
  b.add("50");
  assert.equal(b.used(), 0);
});

test("estimateRunSize buckets agent counts", () => {
  assert.equal(estimateRunSize(1), "low");
  assert.equal(estimateRunSize(4), "low");
  assert.equal(estimateRunSize(5), "medium");
  assert.equal(estimateRunSize(8), "medium");
  assert.equal(estimateRunSize(9), "high");
  assert.equal(estimateRunSize(100), "high");
});

test("envLargeRunAgents defaults to 5 subtasks", () => {
  assert.equal(envLargeRunAgents({}), 5);
  assert.equal(envLargeRunAgents({ GHCP_MAESTRO_LARGE_RUN_AGENTS: "3" }), 3);
  assert.equal(envLargeRunAgents({ GHCP_MAESTRO_LARGE_RUN_AGENTS: "0" }), 5);
  assert.equal(envLargeRunAgents({ GHCP_MAESTRO_LARGE_RUN_AGENTS: "x" }), 5);
});
