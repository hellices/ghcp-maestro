import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planApprovalGate,
  phaseApprovalGate,
} from "../core/plan-approval.mjs";

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
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["0", "1", "2"] } }));
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
  // user picks index keys 2 then 0; selection still follows plan order
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["2", "0"] } }));
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
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["0", "1", "2"] } }));
  await planApprovalGate({ specs: SPECS, ui, capabilities: INTERACTIVE });
  const params = ui.calls[0];
  const field = params.requestedSchema.properties.subtasks;
  // stable index keys, with human-readable labels carrying the agent names
  assert.deepEqual(field.items.enum, ["0", "1", "2"]);
  assert.deepEqual(field.items.enumNames, ["alpha", "beta", "gamma"]);
  assert.deepEqual(field.default, ["0", "1", "2"]);
  assert.equal(params.requestedSchema.required.includes("subtasks"), true);
});

test("each subtask prompt preview is logged before the dialog", async () => {
  const logs = [];
  const ui = fakeUi(() => ({ action: "accept", content: { subtasks: ["0", "1", "2"] } }));
  await planApprovalGate({
    specs: SPECS,
    ui,
    capabilities: INTERACTIVE,
    log: (m) => { logs.push(m); },
  });
  assert.equal(logs.some((l) => l.includes("alpha") && l.includes("do alpha")), true);
  assert.equal(logs.some((l) => l.includes("beta") && l.includes("do beta")), true);
});

test("duplicate agent names are selected independently by a stable key", async () => {
  // Two subtasks share the agent name "dup". Selecting only the FIRST must
  // approve exactly one spec — not both. The dialog offers stable index keys
  // (with human-readable enumNames), so the reply references those keys.
  const dupSpecs = [
    { agent: "dup", prompt: "first" },
    { agent: "solo", prompt: "middle" },
    { agent: "dup", prompt: "second" },
  ];
  let captured;
  const ui = {
    calls: [],
    async elicitation(params) {
      captured = params;
      return { action: "accept", content: { subtasks: ["0"] } };
    },
  };
  const res = await planApprovalGate({ specs: dupSpecs, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, true);
  assert.equal(res.selected.length, 1);
  assert.equal(res.selected[0].prompt, "first");
  const field = captured.requestedSchema.properties.subtasks;
  assert.deepEqual(field.items.enum, ["0", "1", "2"]);
  assert.deepEqual(field.items.enumNames, ["dup", "solo", "dup"]);
});

test("an estimate string is shown in the note and the elicitation message", async () => {
  const notes = [];
  let captured;
  const ui = {
    async elicitation(params) {
      captured = params;
      return { action: "accept", content: { subtasks: ["0", "1", "2"] } };
    },
  };
  const res = await planApprovalGate({
    specs: SPECS,
    ui,
    capabilities: INTERACTIVE,
    estimate: "est. run size: medium (5 agents incl. plan+synth)",
    log: (msg) => notes.push(msg),
  });
  assert.equal(res.approved, true);
  assert.ok(notes.some((n) => /est\. run size: medium/.test(n)));
  assert.match(captured.message, /est\. run size: medium/);
});

// ── phaseApprovalGate (#15) ────────────────────────────────────────────────

const PHASE_RESULTS = [
  { agent: "alpha", status: "ok", preview: "alpha findings" },
  { agent: "beta", status: "ok", preview: "beta findings" },
  { agent: "gamma", status: "error", preview: "boom" },
];

test("phase gate: autoApprove proceeds without a dialog (#15)", async () => {
  const ui = fakeUi(() => {
    throw new Error("ui must not be called when autoApprove is set");
  });
  const res = await phaseApprovalGate({
    phase: "explore",
    next: "synth",
    results: PHASE_RESULTS,
    ui,
    capabilities: INTERACTIVE,
    autoApprove: true,
  });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "auto-approve");
  assert.equal(ui.calls.length, 0);
});

test("phase gate: non-interactive host proceeds without a dialog (#15)", async () => {
  const ui = fakeUi(() => {
    throw new Error("ui must not be called on a non-interactive host");
  });
  for (const capabilities of [undefined, {}, { ui: {} }, { ui: { elicitation: false } }]) {
    const res = await phaseApprovalGate({ results: PHASE_RESULTS, ui, capabilities });
    assert.equal(res.approved, true, JSON.stringify(capabilities));
    assert.equal(res.reason, "non-interactive");
  }
  assert.equal(ui.calls.length, 0);
});

test("phase gate: accepting proceeds to the next phase (#15)", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { proceed: true } }));
  const res = await phaseApprovalGate({
    phase: "explore",
    next: "synth",
    results: PHASE_RESULTS,
    ui,
    capabilities: INTERACTIVE,
  });
  assert.equal(res.approved, true);
  assert.equal(res.reason, "approved");
  assert.equal(ui.calls.length, 1);
});

test("phase gate: accepting with proceed unchecked stops the run (#15)", async () => {
  const ui = fakeUi(() => ({ action: "accept", content: { proceed: false } }));
  const res = await phaseApprovalGate({
    results: PHASE_RESULTS,
    ui,
    capabilities: INTERACTIVE,
  });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "declined");
});

test("phase gate: declining or cancelling stops the run (#15)", async () => {
  for (const [action, reason] of [["decline", "declined"], ["cancel", "cancelled"]]) {
    const ui = fakeUi(() => ({ action }));
    const res = await phaseApprovalGate({ results: PHASE_RESULTS, ui, capabilities: INTERACTIVE });
    assert.equal(res.approved, false, action);
    assert.equal(res.reason, reason);
  }
});

test("phase gate: a dialog that throws fails closed (#15)", async () => {
  const ui = fakeUi(() => {
    throw new Error("host dialog crashed");
  });
  const res = await phaseApprovalGate({ results: PHASE_RESULTS, ui, capabilities: INTERACTIVE });
  assert.equal(res.approved, false);
  assert.match(res.reason, /^error:/);
});

test("phase gate: per-agent digest is logged and the message counts ok/failed (#15)", async () => {
  const logs = [];
  let captured;
  const ui = {
    async elicitation(params) {
      captured = params;
      return { action: "accept", content: { proceed: true } };
    },
  };
  await phaseApprovalGate({
    phase: "explore",
    next: "synth",
    results: PHASE_RESULTS,
    ui,
    capabilities: INTERACTIVE,
    log: (m) => { logs.push(m); },
  });
  assert.ok(logs.some((l) => /alpha \[ok\].*alpha findings/.test(l)));
  assert.ok(logs.some((l) => /gamma \[error\]/.test(l)));
  assert.match(captured.message, /2 ok/);
  assert.match(captured.message, /1 failed/);
  assert.match(captured.message, /synth/);
});

test("phase gate: a missing status counts as unknown, not failed (#15)", async () => {
  let captured;
  const ui = {
    async elicitation(params) {
      captured = params;
      return { action: "accept", content: { proceed: true } };
    },
  };
  await phaseApprovalGate({
    results: [
      { agent: "alpha", status: "ok", preview: "fine" },
      { agent: "beta", preview: "no status reported" },
    ],
    ui,
    capabilities: INTERACTIVE,
  });
  assert.match(captured.message, /1 ok \/ 0 failed \/ 1 unknown of 2/);
});
