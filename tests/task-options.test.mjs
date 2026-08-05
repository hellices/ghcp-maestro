import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskOptions,
  serializeTaskOptions,
  MAX_EXPLICIT_AGENTS,
  MAX_TASK_CONCURRENCY,
} from "../core/task-options.mjs";

test("task options default to automatic sizing", () => {
  assert.deepEqual(parseTaskOptions("audit the API"), {
    task: "audit the API",
    write: false,
    allowDirty: false,
    agents: undefined,
    concurrency: undefined,
  });
});

test("task options compose at the leading edge", () => {
  assert.deepEqual(
    parseTaskOptions("--write --allow-dirty --agents 30 --concurrency 6 migrate"),
    {
      task: "migrate",
      write: true,
      allowDirty: true,
      agents: 30,
      concurrency: 6,
    },
  );
});

test("task options compose at the trailing edge", () => {
  const got = parseTaskOptions("migrate --agents 12 --concurrency 4 --write");
  assert.equal(got.task, "migrate");
  assert.equal(got.agents, 12);
  assert.equal(got.concurrency, 4);
  assert.equal(got.write, true);
});

test("option-like text in the middle remains task content", () => {
  assert.equal(
    parseTaskOptions("explain --agents 12 behavior").task,
    "explain --agents 12 behavior",
  );
});

test("invalid, duplicate, and empty task options fail", () => {
  assert.throws(() => parseTaskOptions("--agents nope audit"), /--agents.*integer/i);
  assert.throws(() => parseTaskOptions("--agents 2 --agents 3 audit"), /duplicate.*--agents/i);
  assert.throws(() => parseTaskOptions(`--agents ${MAX_EXPLICIT_AGENTS + 1} audit`), /1-50/);
  assert.throws(() => parseTaskOptions(`--concurrency ${MAX_TASK_CONCURRENCY + 1} audit`), /1-16/);
  assert.throws(() => parseTaskOptions("--agents 4"), /task description/i);
});

test("bare leading task options require values", () => {
  assert.throws(() => parseTaskOptions("--agents"), /--agents.*missing value/i);
  assert.throws(() => parseTaskOptions("--concurrency"), /--concurrency.*missing value/i);
});

test("bare trailing task options require values", () => {
  assert.throws(() => parseTaskOptions("do work --concurrency"), /--concurrency.*missing value/i);
  assert.throws(() => parseTaskOptions("do work --agents"), /--agents.*missing value/i);
});

test("programmatic overrides are validated and serialized canonically", () => {
  const options = parseTaskOptions("--write migrate", { agents: 30, concurrency: 16 });
  assert.equal(
    serializeTaskOptions(options),
    "--agents 30 --concurrency 16 --write migrate",
  );
});

test("task options preserve interior newlines in multiline input", () => {
  assert.deepEqual(parseTaskOptions("--write migrate\n- step one\n- step two"), {
    task: "migrate\n- step one\n- step two",
    write: true,
    allowDirty: false,
    agents: undefined,
    concurrency: undefined,
  });
});
