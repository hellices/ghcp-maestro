import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenTreeRows,
  rowLabel,
  rowDescription,
  rowIcon,
} from "../vscode-extension/views/runs-tree-provider.mjs";
import { renderConsoleHtml } from "../vscode-extension/views/console-panel.mjs";

const SNAPSHOT = {
  runs: [
    {
      id: "r1",
      status: "running",
      task: "react-to-solid migration",
      counts: { total: 3, done: 1, failed: 0, running: 2 },
      phases: [
        {
          name: "explore",
          counts: { total: 2, done: 1, failed: 0, running: 1 },
          agents: [
            { id: "a1", status: "ok", model: "gpt-5", tokens: 1200, toolCount: 4, durationMs: 5300, prompt: "scan routes", output: "done" },
            { id: "a2", status: "running", model: "gpt-5", tokens: 0, toolCount: 1, durationMs: undefined, prompt: "scan state" },
          ],
        },
        {
          name: "synthesize",
          counts: { total: 1, done: 0, failed: 0, running: 1 },
          agents: [{ id: "s1", status: "running", model: "gpt-5", tokens: 0, toolCount: 0 }],
        },
      ],
    },
  ],
};

test("flattens run snapshot into run->phase->agent rows", () => {
  const rows = flattenTreeRows(SNAPSHOT);
  assert.deepEqual(rows.map((r) => r.kind), ["run", "phase", "agent", "agent", "phase", "agent"]);
});

test("rows carry the ids needed to drill into the console", () => {
  const rows = flattenTreeRows(SNAPSHOT);
  const agent = rows.find((r) => r.kind === "agent");
  assert.equal(agent.runId, "r1");
  assert.equal(agent.phase, "explore");
  assert.equal(agent.agentId, "a1");
  assert.equal(agent.id, "r1:explore:a1");
});

test("rowLabel summarises run/phase/agent", () => {
  assert.equal(rowLabel({ kind: "run", id: "r1", task: "react-to-solid migration" }), "react-to-solid migration");
  assert.equal(rowLabel({ kind: "phase", phase: "explore" }), "explore");
  assert.equal(rowLabel({ kind: "agent", agentId: "a1" }), "a1");
});

test("rowDescription shows counts for run/phase and metrics for agent", () => {
  assert.match(rowDescription({ kind: "run", counts: { total: 3, done: 1, failed: 0, running: 2 } }), /1\/3/);
  assert.match(rowDescription({ kind: "phase", counts: { total: 2, done: 1, failed: 0, running: 1 } }), /1\/2/);
  assert.match(rowDescription({ kind: "agent", model: "gpt-5", tokens: 1200, toolCount: 4, durationMs: 5300 }), /gpt-5/);
});

test("rowIcon maps status to a themeable codicon id", () => {
  assert.equal(rowIcon({ kind: "agent", status: "ok" }), "pass");
  assert.equal(rowIcon({ kind: "agent", status: "running" }), "loading~spin");
  assert.equal(rowIcon({ kind: "agent", status: "error" }), "error");
});

test("renderConsoleHtml embeds the snapshot and selected run", () => {
  const html = renderConsoleHtml(SNAPSHOT, { runId: "r1", phase: "explore", agentId: "a1" });
  assert.match(html, /react-to-solid migration/);
  assert.match(html, /acquireVsCodeApi/);
  // snapshot is serialised for the client renderer
  assert.match(html, /__MAESTRO_STATE__/);
  // no raw </script> breakage from injected JSON
  assert.ok(!/<\/script>\s*<\/script>/.test(html));
});

test("renderConsoleHtml is safe with an empty snapshot", () => {
  const html = renderConsoleHtml({ runs: [] }, {});
  assert.match(html, /No runs yet|No run selected/);
});
