import { test } from "node:test";
import assert from "node:assert/strict";
import { createMaestroParticipant } from "../vscode-extension/chat/participant.mjs";

function captureLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    logPort: {
      info: (m) => lines.info.push(m),
      warn: (m) => lines.warn.push(m),
      error: (m) => lines.error.push(m),
    },
    lines,
  };
}

test("delegates a subcommand to the runtime port with input and request ctx", async () => {
  let got = null;
  let gotCtx = null;
  const participant = createMaestroParticipant({
    runtimePort: {
      runCommand: async (input, ctx) => {
        got = input;
        gotCtx = ctx;
      },
      resumeRun: async () => {},
      stopRun: async () => {},
    },
  });
  const { logPort } = captureLog();
  await participant.handleRequest("/maestro task investigate flaky test", { logPort });
  assert.equal(got.subcommand, "task");
  assert.equal(got.args, "investigate flaky test");
  assert.equal(gotCtx.logPort, logPort);
});

test("strips a leading @maestro mention as well as the /maestro slash", async () => {
  const seen = [];
  const participant = createMaestroParticipant({
    runtimePort: { runCommand: async (i) => seen.push(i), resumeRun: async () => {}, stopRun: async () => {} },
  });
  const { logPort } = captureLog();
  await participant.handleRequest("@maestro workflows", { logPort });
  assert.deepEqual(seen, [{ subcommand: "workflows", args: "" }]);
});

test("empty input renders help via logPort.info", async () => {
  const participant = createMaestroParticipant({
    runtimePort: { runCommand: async () => {}, resumeRun: async () => {}, stopRun: async () => {} },
  });
  const { logPort, lines } = captureLog();
  await participant.handleRequest("/maestro", { logPort });
  assert.equal(lines.info.length, 1);
  assert.match(lines.info[0], /\/maestro task <task description>/);
});

test("unknown subcommand warns via logPort.warn", async () => {
  const participant = createMaestroParticipant({
    runtimePort: { runCommand: async () => {}, resumeRun: async () => {}, stopRun: async () => {} },
  });
  const { logPort, lines } = captureLog();
  await participant.handleRequest("/maestro bogus stuff", { logPort });
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /bogus/);
});

test("missing required arg warns via logPort.warn and does not call runtime", async () => {
  let called = 0;
  const participant = createMaestroParticipant({
    runtimePort: { runCommand: async () => (called += 1), resumeRun: async () => {}, stopRun: async () => {} },
  });
  const { logPort, lines } = captureLog();
  await participant.handleRequest("/maestro task", { logPort });
  assert.equal(called, 0);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /task/);
});
