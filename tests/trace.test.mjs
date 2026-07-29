import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTraceSpans, hexId } from "../core/trace.mjs";

test("hexId is deterministic and sized", () => {
  assert.equal(hexId("seed", 16), hexId("seed", 16));
  assert.equal(hexId("seed", 16).length, 32);
  assert.equal(hexId("seed", 8).length, 16);
  assert.notEqual(hexId("a", 8), hexId("b", 8));
  assert.match(hexId("seed", 16), /^[0-9a-f]{32}$/);
});

test("buildTraceSpans emits an invoke_workflow root with GenAI attributes", () => {
  const { traceId, spans } = buildTraceSpans({
    manifest: {
      runId: "run-1",
      workflow: "task",
      status: "complete",
      startedAt: 1000,
      finishedAt: 2000,
      tokensUsed: 42,
    },
    agents: [],
  });
  assert.equal(spans.length, 1);
  const root = spans[0];
  assert.equal(root.traceId, traceId);
  assert.equal(root.name, "invoke_workflow task");
  assert.equal(root.attributes["gen_ai.operation.name"], "invoke_workflow");
  assert.equal(root.attributes["gen_ai.conversation.id"], "run-1");
  assert.equal(root.attributes["gen_ai.usage.total_tokens"], 42);
  assert.equal(root.startTimeUnixNano, "1000000000");
  assert.equal(root.endTimeUnixNano, "2000000000");
  assert.equal(root.status.code, "STATUS_CODE_OK");
});

test("buildTraceSpans keeps epoch-millisecond timestamps exact in nanos", () => {
  // 1.7e12 ms × 1e6 = 1.7e18 ns > Number.MAX_SAFE_INTEGER — a float multiply
  // would corrupt the low digits.
  const startedAt = 1_735_689_600_123;
  const { spans } = buildTraceSpans({
    manifest: { runId: "run-1", workflow: "task", status: "complete", startedAt },
    agents: [],
  });
  assert.equal(spans[0].startTimeUnixNano, "1735689600123000000");
});

test("buildTraceSpans emits one invoke_agent child per record, sorted by start", () => {
  const { spans } = buildTraceSpans({
    manifest: { runId: "run-1", workflow: "task", status: "complete" },
    agents: [
      { agentId: "synth", spec: { agent: "synth" }, status: "ok", startedAt: 300, finishedAt: 400 },
      {
        agentId: "explore-0-a",
        spec: { agent: "a", model: "fast" },
        status: "ok",
        startedAt: 100,
        finishedAt: 200,
        attempts: 1,
      },
    ],
  });
  assert.equal(spans.length, 3);
  const [root, first, second] = spans;
  assert.equal(first.name, "invoke_agent a");
  assert.equal(second.name, "invoke_agent synth");
  assert.equal(first.parentSpanId, root.spanId);
  assert.equal(first.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(first.attributes["gen_ai.agent.name"], "a");
  assert.equal(first.attributes["gen_ai.request.model"], "fast");
  assert.equal(first.attributes["ghcp_maestro.attempts"], 1);
  assert.ok(!("gen_ai.request.model" in second.attributes), "no model attr without routing");
});

test("buildTraceSpans marks failed agents and error runs", () => {
  const { spans } = buildTraceSpans({
    manifest: { runId: "run-1", workflow: "task", status: "error" },
    agents: [{ agentId: "x", spec: { agent: "x" }, status: "timeout", error: "took too long" }],
  });
  const [root, child] = spans;
  assert.equal(root.status.code, "STATUS_CODE_ERROR");
  assert.equal(child.attributes["error.type"], "timeout");
  assert.equal(child.status.code, "STATUS_CODE_ERROR");
  assert.equal(child.status.message, "took too long");
});

test("buildTraceSpans keeps an agent literally named 'root' distinct from the root span", () => {
  const { spans } = buildTraceSpans({
    manifest: { runId: "run-1", workflow: "task", status: "complete" },
    agents: [{ agentId: "root", spec: { agent: "root" }, status: "ok" }],
  });
  const [root, child] = spans;
  assert.notEqual(child.spanId, root.spanId, "agent span seed must be namespaced");
  assert.equal(child.parentSpanId, root.spanId);
});
