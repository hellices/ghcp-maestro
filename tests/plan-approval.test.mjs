import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planApprovalGate,
} from "../extensions/ghcp-maestro/runtime/plan-approval.mjs";

// A fake `session.ui` that records the params it was called with and replies
// according to `responder(params)`. Deterministic — no real host dialog.
function fakeUi(responder) {
  const calls = [];
  return {
    calls,
    async elicitation(params) {
      calls.push(params);
      return responder(params);
    },
  };
}

const INTERACTIVE = { ui: { elicitation: true } };
const SPECS = [
  { agent: "alpha", prompt: "do alpha" },
  { agent: "beta", prompt: "do beta" },
  { agent: "gamma", prompt: "do gamma" },
];

test("autoApprove bypasses the dialog and approves every spec", async () => {
  const ui = fakeUi(() => {
    throw new Error("ui must not be called when autoApprove is set");
  });
  const res = await planApprovalGate({
    specs: SPECS,
    ui,
    capabilities: INTERACTIVE,
    autoApprove: true,
  });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "auto-approve");
  assert.deepEqual(res.selected.map((s) => s.agent), ["alpha", "beta", "gamma"]);
  assert.equal(ui.calls.length, 0);
});

test("non-interactive host (no elicitation capability) approves without a dialog", async () => {
  const ui = fakeUi(() => {
    throw new Error("ui must not be called when host is non-interactive");
  });
  for (const capabilities of [undefined, {}, { ui: {} }, { ui: { elicitation: false } }]) {
    const res = await planApprovalGate({ specs: SPECS, ui, capabilities });
    assert.equal(res.approved, true, JSON.stringify(capabilities));
    assert.equal(res.reason, "non-interactive");
    assert.equal(res.selected.length, 3);
  }
  assert.equal(ui.calls.length, 0);
});

test("a missing ui object is treated as non-interactive", async () => {
  const res = await planApprovalGate({
    specs: SPECS,
    ui: null,
    capabilities: INTERACTIVE,
  });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "non-interactive");
});

test("accepting with every subtask selected approves all of them", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["alpha", "beta", "gamma"] } }));
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "approved");
  assert.deepEqual(res.selected.map((s) => s.agent), ["alpha", "beta", "gamma"]);
  assert.equal(ui.calls.length, 1);
});

test("declining the dialog rejects the plan and selects nothing", async () => {
  const ui = fakeUi(() => ({ action: "decline" }));
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "declined");
  assert.deepEqual(res.selected, []);
});

test("accepting a subset runs only the selected subtasks, in plan order", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["gamma", "alpha"] } }));
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "approved");
  // selection order follows the plan, not the order the user clicked
  assert.deepEqual(res.selected.map((s) => s.agent), ["alpha", "gamma"]);
});

test("accepting with an empty selection is treated as a no-op abort", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: [] } }));
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "empty-selection");
  assert.deepEqual(res.selected, []);
});

test("cancelling the dialog rejects the plan", async () => {
  const ui = fakeUi(() => ({ action: "cancel" }));
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "cancelled");
});

test("a dialog that throws fails closed (does not silently fan out)", async () => {
  const ui = fakeUi(() => {
    throw new Error("host dialog crashed");
  });
  const res = await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, false);
  assert.match(res.reason, /^error:/);
  assert.deepEqual(res.selected, []);
});

test("the dialog offers every subtask and defaults to all selected", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["alpha", "beta", "gamma"] } }));
  await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  const params = ui.calls[0];
  const field = params.requestedSchema.properties.subtasks;
  assert.deepEqual(field.items.enum, ["alpha", "beta", "gamma"]);
  assert.deepEqual(field.default, ["alpha", "beta", "gamma"]);
  assert.equal(params.requestedSchema.required.includes("subtasks"), true);
});

test("each subtask prompt preview is logged before the dialog", async () => {
  const logs = [];
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["alpha", "beta", "gamma"] } }));
  await planApprovalGate({
    specs: SPECS,
    ui,
    capabilities: INTERACTIVE,
    log: (m) => { logs.push(m); },
  });
  assert.equal(logs.some((l) => l.includes("alpha") && l.includes("do alpha")), true);
  assert.equal(logs.some((l) => l.includes("beta") && l.includes("do beta")), true);
});
