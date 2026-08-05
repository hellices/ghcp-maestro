import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMaestroHelp,
  DIAGNOSTICS_HEADER,
  TASK_COMMAND_SUMMARY,
} from "../core/help.mjs";

const SUBCOMMANDS = [
  { name: "task", needsArg: "task description", summary: "Decompose a task." },
  { name: "brainstorm", needsArg: "topic", summary: "Multi-angle brainstorm." },
  { name: "run", needsArg: "name [args]", summary: "Run a saved workflow." },
  { name: "workflows", needsArg: false, summary: "List saved workflows." },
  { name: "hello", needsArg: false, hidden: true, summary: "Diagnostic smoke." },
  { name: "pong", needsArg: "prompt", hidden: true, summary: "Single-session probe." },
  { name: "help", needsArg: false, summary: "This help." },
];

test("help lists every non-hidden subcommand with its usage and summary", () => {
  const out = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: [] });
  assert.match(out, /\/maestro task <task description>/);
  assert.match(out, /Decompose a task\./);
  assert.match(out, /\/maestro brainstorm <topic>/);
  assert.match(out, /\/maestro workflows\b/);
});

test("help hides subcommands flagged hidden from the main list", () => {
  const out = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: [] });
  const mainSection = out.split(DIAGNOSTICS_HEADER)[0];
  assert.doesNotMatch(mainSection, /\/maestro hello\b/);
  assert.doesNotMatch(mainSection, /\/maestro pong\b/);
});

test("hidden diagnostic subcommands are listed under a Diagnostics section", () => {
  const out = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: [] });
  assert.ok(out.includes(DIAGNOSTICS_HEADER));
  const diag = out.slice(out.indexOf(DIAGNOSTICS_HEADER));
  assert.match(diag, /\/maestro hello\b/);
  assert.match(diag, /\/maestro pong <prompt>/);
});

test("help always includes the run-management commands", () => {
  const out = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: [] });
  assert.match(out, /\/maestros \[runId\]/);
  assert.match(out, /\/maestro-resume <runId>/);
  assert.match(out, /\/maestro-stop <runId>/);
});

test("help lists saved workflows only when present", () => {
  const without = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: [] });
  assert.doesNotMatch(without, /Saved workflows/);
  const withWf = renderMaestroHelp(SUBCOMMANDS, { savedWorkflows: ["deep-review"] });
  assert.match(withWf, /Saved workflows \(1\): deep-review/);
});

test("task help explains agent count and concurrency overrides", () => {
  assert.match(TASK_COMMAND_SUMMARY, /Auto-size 3-16 workers/);
  assert.match(TASK_COMMAND_SUMMARY, /--agents N/);
  assert.match(TASK_COMMAND_SUMMARY, /--concurrency N/);
});
