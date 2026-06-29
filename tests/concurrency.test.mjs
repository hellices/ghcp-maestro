// node:test based unit tests. Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSemaphore,
  runWithConcurrency,
} from "../extensions/ghcp-maestro/runtime/concurrency.mjs";

test("createSemaphore rejects non-positive permits", () => {
  assert.throws(() => createSemaphore(0), TypeError);
  assert.throws(() => createSemaphore(-1), TypeError);
  assert.throws(() => createSemaphore(1.5), TypeError);
});

test("semaphore caps concurrent holders", async () => {
  const sem = createSemaphore(2);
  let inFlight = 0;
  let peak = 0;

  async function task(ms) {
    const release = await sem.acquire();
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight -= 1;
    release();
  }

  await Promise.all([task(20), task(20), task(20), task(20), task(20)]);
  assert.equal(peak, 2);
});

test("runWithConcurrency preserves input order", async () => {
  const tasks = [50, 10, 30, 5, 20].map((ms, i) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  const out = await runWithConcurrency(tasks, { concurrency: 2 });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test("runWithConcurrency enforces concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, () => async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
  });
  await runWithConcurrency(tasks, { concurrency: 4 });
  assert.equal(peak, 4);
});

test("runWithConcurrency throws first error, lets in-flight finish", async () => {
  const order = [];
  const tasks = [
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("a");
      throw new Error("boom-a");
    },
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("b");
      return "b";
    },
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("c");
      return "c";
    },
  ];
  await assert.rejects(
    () => runWithConcurrency(tasks, { concurrency: 3 }),
    /boom-a/,
  );
  // b and c started before a failed; they should still complete.
  assert.ok(order.includes("b"), "in-flight b should complete");
});

test("runWithConcurrency aborts on pre-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort(new Error("nope"));
  await assert.rejects(
    () =>
      runWithConcurrency([async () => 1], {
        concurrency: 1,
        signal: ac.signal,
      }),
    /nope/,
  );
});

test("runWithConcurrency rejects bad inputs", async () => {
  await assert.rejects(
    () => runWithConcurrency([], { concurrency: 0 }),
    TypeError,
  );
  await assert.rejects(
    () => runWithConcurrency("nope", { concurrency: 1 }),
    TypeError,
  );
});
