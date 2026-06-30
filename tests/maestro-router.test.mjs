import { test } from "node:test";
import assert from "node:assert/strict";
import { createMaestroRouter } from "../extensions/ghcp-maestro/runtime/maestro-router.mjs";

function makeHarness(overrides = {}) {
  const calls = { help: 0, unknown: [], missingArg: [], bgError: [], ran: [] };
  const subcommands = overrides.subcommands ?? [
    {
      name: "task",
      needsArg: "task description",
      run: async (arg) => calls.ran.push(["task", arg]),
    },
    {
      name: "workflows",
      needsArg: false,
      run: async (arg) => calls.ran.push(["workflows", arg]),
    },
    { name: "help", needsArg: false, run: async () => calls.ran.push(["help", ""]) },
  ];
  const router = createMaestroRouter({
    subcommands,
    onHelp: async () => {
      calls.help += 1;
    },
    onUnknown: async (head) => {
      calls.unknown.push(head);
    },
    onMissingArg: async (sc) => {
      calls.missingArg.push(sc.name);
    },
    onBackgroundError: async (sc, err) => {
      calls.bgError.push([sc.name, err?.message ?? String(err)]);
    },
  });
  return { router, calls };
}

test("dispatches a known subcommand with the trimmed tail args", async () => {
  const { router, calls } = makeHarness();
  await router.dispatch("task   investigate timeout  ");
  assert.deepEqual(calls.ran, [["task", "investigate timeout"]]);
});

test("empty/help/-h/--help all route to onHelp", async () => {
  for (const input of ["", "   ", "help", "-h", "--help"]) {
    const { router, calls } = makeHarness();
    await router.dispatch(input);
    assert.equal(calls.help, 1, `input=${JSON.stringify(input)}`);
    assert.deepEqual(calls.ran, []);
  }
});

test("unknown subcommand routes to onUnknown with the head token", async () => {
  const { router, calls } = makeHarness();
  await router.dispatch("nope do something");
  assert.deepEqual(calls.unknown, ["nope"]);
  assert.deepEqual(calls.ran, []);
});

test("subcommand needing an arg with no tail routes to onMissingArg", async () => {
  const { router, calls } = makeHarness();
  await router.dispatch("task");
  assert.deepEqual(calls.missingArg, ["task"]);
  assert.deepEqual(calls.ran, []);
});

test("a no-arg subcommand runs even without a tail", async () => {
  const { router, calls } = makeHarness();
  await router.dispatch("workflows");
  assert.deepEqual(calls.ran, [["workflows", ""]]);
});

test("background subcommands are fire-and-forget: dispatch resolves before run settles", async () => {
  let resolveRun;
  const ranOrder = [];
  const subcommands = [
    {
      name: "task",
      needsArg: "task description",
      background: true,
      run: () =>
        new Promise((resolve) => {
          resolveRun = () => {
            ranOrder.push("run-done");
            resolve();
          };
        }),
    },
  ];
  const { router } = makeHarness({ subcommands });
  await router.dispatch("task long job");
  ranOrder.push("dispatch-returned");
  resolveRun();
  await Promise.resolve();
  assert.deepEqual(ranOrder, ["dispatch-returned", "run-done"]);
});

test("background subcommand failures route to onBackgroundError", async () => {
  const subcommands = [
    {
      name: "task",
      needsArg: "task description",
      background: true,
      run: async () => {
        throw new Error("boom");
      },
    },
  ];
  const { router, calls } = makeHarness({ subcommands });
  await router.dispatch("task explode");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.bgError, [["task", "boom"]]);
});

test("non-background subcommand awaits run before resolving", async () => {
  const order = [];
  const subcommands = [
    {
      name: "pong",
      needsArg: "prompt",
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("run-done");
      },
    },
  ];
  const { router } = makeHarness({ subcommands });
  await router.dispatch("pong ping");
  order.push("dispatch-returned");
  assert.deepEqual(order, ["run-done", "dispatch-returned"]);
});
