# Real-time in-TUI run monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, refreshing dashboard of an in-flight ghcp-maestro fan-out
(per-agent state + elapsed + streamed bytes) inside the host Copilot CLI TUI.

**Architecture:** A pure aggregator (`runtime/monitor.mjs`) turns a stream of
per-agent progress events into a compact dashboard string and renders it via
throttled **ephemeral** host logs. Progress flows from each child session: the
standalone adapter subscribes to the child `CopilotSession` events, normalizes
them, and emits them through a new `onProgress` sink threaded by
`spawn`/`spawnAll`. Implements Approach A from
`docs/specs/2026-06-30-tui-realtime-monitoring-design.md` (issue #2).

**Tech Stack:** Node.js ≥ 20 ESM (`.mjs`), `node:test` + `node:assert/strict`,
`@github/copilot-sdk` (extension + standalone client). Zero runtime dependencies.

## Global Constraints

- Runtime output via `session.log()` only — never `console.*` or direct stdout
  (breaks JSON-RPC). The dashboard renders through `session.log(text, { ephemeral: true })`.
- ESM only; all artifacts are `.mjs`; `package.json` has `"type": "module"`.
- Zero new runtime dependencies (eslint/etc. stay devDependencies).
- Slash command prefix `maestro`; tool prefix `ghcp_maestro_*` (unchanged here).
- Concurrency: global cap 1000 agents/run, default 16 (unchanged).
- Monitoring must be **best-effort and non-interfering**: a monitor or event-handler
  error must never break `sendAndWait` or change `spawnAll` results.
- Run the suite with `node --test tests/*.test.mjs`; full gate is `npm run check`
  (ESLint + tests). Every commit includes the trailer
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File Structure

- Create `extensions/ghcp-maestro/runtime/monitor.mjs` — pure progress aggregator
  + deterministic throttle + dashboard formatter. One responsibility: turn
  progress events into a rendered string.
- Modify `extensions/ghcp-maestro/runtime/spawn.mjs` — thread an `onProgress`
  sink through `spawn`/`spawnAll` and enrich adapter-emitted partials with
  `agent`/`specId`/`ts`.
- Modify `extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs` — add a
  pure `normalizeChildEvent` + `subscribeProgress(session, onProgress)` and wire
  the subscription into `invoke` (unsubscribe in `finally`).
- Modify `extensions/ghcp-maestro/extension.mjs` — `monitorEnabled(env)` helper +
  create a monitor per run and feed `onProgress`/`settle` in `runTaskWorkflow`,
  `runBrainstormWorkflow`, `runHelloWorkflow`.
- Create `tests/monitor.test.mjs`, `tests/spawn-progress.test.mjs`,
  `tests/standalone-progress.test.mjs`.
- Modify `docs/CHANGELOG.md`, `README.md`, `README.ko.md`.

## Shared contracts (used across tasks)

**Partial progress** (emitted by an adapter through `ctx.onProgress`):
`{ state: "running" | "streaming" | "tool", bytes?: number, tool?: string, tokens?: number }`

**ProgressEvent** (enriched by `spawn`, consumed by the monitor):
`{ agent: string|null, specId: string, state: string, bytes?: number, tool?: string, tokens?: number, ts: number }`

**Monitor agent states:** `pending | running | streaming | tool | done | failed`.

> **Token totals (design §2 / §4b):** `tokens` is the per-event token delta from
> the child's `assistant.usage` event (`inputTokens + outputTokens`). The monitor
> accumulates it per agent and sums per phase so the dashboard header shows a
> phase token total — parity with Claude Code's `/workflows` progress view. The
> tasks below include the `tokens` field end-to-end; v2 parity items (drill-down,
> pause/stop/restart) are tracked in the design doc §11, not this v1 plan.

---

### Task 1: `runtime/monitor.mjs` — pure aggregator + throttle + formatter

**Files:**
- Create: `extensions/ghcp-maestro/runtime/monitor.mjs`
- Test: `tests/monitor.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `createMonitor({ label, render, now?, throttleMs? }) => Monitor`
  - `Monitor.seed(specs: Array<{ id: string, agent: string }>): void`
  - `Monitor.onProgress(evt: { specId, agent?, state, bytes?, tool?, tokens?, ts? }): void`
  - `Monitor.settle(specId: string, ok: boolean): void`
  - `Monitor.flush(): void`
  - `Monitor.format(): string`
  - `now` defaults to `Date.now`; `throttleMs` defaults to `500`.
  - `onProgress` accumulates `tokens` per agent; `format()` shows a per-phase
    token total in the header and a per-agent token column (design §2 / §4b).

- [ ] **Step 1: Write the failing test**

Create `tests/monitor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitor } from "../extensions/ghcp-maestro/runtime/monitor.mjs";

// Deterministic clock + captured render output.
function harness(throttleMs = 500) {
  let t = 1000;
  const renders = [];
  const monitor = createMonitor({
    label: "ghcp-maestro/run1 explore",
    render: (text) => renders.push(text),
    now: () => t,
    throttleMs,
  });
  return { monitor, renders, tick: (ms) => { t += ms; }, at: (ms) => { t = ms; } };
}

test("seed lists every agent as pending in the dashboard", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  const out = monitor.format();
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.match(out, /0\/2 done/);
});

test("a state transition renders immediately", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "running" });
  assert.equal(renders.length, 1);
  assert.match(renders[0], /alpha/);
});

test("streaming deltas are throttled to one render per interval", () => {
  const { monitor, renders, tick } = harness(500);
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 100 }); // first: renders
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 200 }); // within window: dropped
  assert.equal(renders.length, 1);
  tick(600);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 300 }); // window elapsed: renders
  assert.equal(renders.length, 2);
});

test("settle marks done/failed and updates the done count", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.settle("e0", true);
  monitor.settle("e1", false);
  const out = monitor.format();
  assert.match(out, /2\/2 done/);
  assert.match(out, /alpha/);
  assert.match(out, /✓/);
  assert.match(out, /✗/);
  assert.equal(renders.length, 2); // settle always renders
});

test("flush forces a render even with no new progress", () => {
  const { monitor, renders } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  const before = renders.length;
  monitor.flush();
  assert.equal(renders.length, before + 1);
});

test("streamed bytes are shown once known", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 2048 });
  assert.match(monitor.format(), /2(\.0)?\s?KB/);
});

test("tokens accumulate per agent and sum into the phase header", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.onProgress({ specId: "e0", state: "running", tokens: 1000 });
  monitor.onProgress({ specId: "e0", state: "streaming", tokens: 500 }); // alpha: 1500
  monitor.onProgress({ specId: "e1", state: "running", tokens: 2000 }); // beta: 2000
  const out = monitor.format();
  // per-phase total 3500 in the header, abbreviated to "3.5K tok"
  assert.match(out, /3\.5K tok/);
});

test("an unknown specId is ignored, never throws", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  assert.doesNotThrow(() => monitor.onProgress({ specId: "nope", state: "running" }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/monitor.test.mjs`
Expected: FAIL — `Cannot find module .../runtime/monitor.mjs`.

- [ ] **Step 3: Write the minimal implementation**

Create `extensions/ghcp-maestro/runtime/monitor.mjs`:

```js
// Live run monitor (issue #2). Pure aggregator: turns per-agent progress events
// into a compact dashboard string and renders it through an injected sink,
// throttling high-frequency streaming updates. No SDK / IO here — the caller
// wires `render` to session.log(text, { ephemeral: true }).

const GLYPH = {
  pending: "·",
  running: "⠿",
  streaming: "⠿",
  tool: "⠿",
  done: "✓",
  failed: "✗",
};

/**
 * @param {{
 *   label: string,
 *   render: (text: string) => void,
 *   now?: () => number,
 *   throttleMs?: number,
 * }} opts
 */
export function createMonitor(opts) {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? 500;
  const label = opts.label ?? "ghcp-maestro";
  const agents = new Map(); // specId -> { id, agent, state, bytes, tokens, startTs, lastTs }
  let lastRenderTs = -Infinity;

  function doRender() {
    lastRenderTs = now();
    try {
      opts.render(format());
    } catch {
      // rendering is best-effort; never propagate
    }
  }

  function maybeRender(state) {
    if (state === "streaming") {
      if (now() - lastRenderTs >= throttleMs) doRender();
      return;
    }
    doRender();
  }

  function format() {
    const list = [...agents.values()];
    const done = list.filter((a) => a.state === "done" || a.state === "failed").length;
    const maxElapsed = list.reduce((m, a) => Math.max(m, now() - a.startTs), 0);
    const totalTokens = list.reduce((m, a) => m + a.tokens, 0);
    const tokTotal = totalTokens ? ` · ${ktok(totalTokens)} tok` : "";
    const header = `${label} · ${done}/${list.length} done · ${mmss(maxElapsed)}${tokTotal}`;
    const rows = list.map((a) => {
      const glyph = GLYPH[a.state] ?? "·";
      const secs = `${Math.round((now() - a.startTs) / 1000)}s`;
      const bytes = a.bytes ? `  ${kb(a.bytes)}` : "";
      const tool = a.state === "tool" && a.tool ? `  (${a.tool})` : "";
      const tok = a.tokens ? `  ${ktok(a.tokens)} tok` : "";
      return `  ${glyph} ${a.agent}  ${a.state}  ${secs}${bytes}${tool}${tok}`;
    });
    return [header, ...rows].join("\n");
  }

  return {
    seed(specs) {
      for (const s of specs ?? []) {
        agents.set(s.id, {
          id: s.id,
          agent: s.agent,
          state: "pending",
          bytes: 0,
          tokens: 0,
          startTs: now(),
          lastTs: now(),
        });
      }
    },
    onProgress(evt) {
      const a = agents.get(evt?.specId);
      if (!a) return;
      if (evt.state) a.state = evt.state;
      if (typeof evt.bytes === "number") a.bytes = Math.max(a.bytes, evt.bytes);
      if (typeof evt.tokens === "number") a.tokens += evt.tokens;
      if (evt.tool) a.tool = evt.tool;
      a.lastTs = now();
      maybeRender(a.state);
    },
    settle(specId, ok) {
      const a = agents.get(specId);
      if (!a) return;
      a.state = ok ? "done" : "failed";
      a.lastTs = now();
      doRender();
    },
    flush() {
      doRender();
    },
    format,
  };
}

function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function ktok(tokens) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/monitor.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/ghcp-maestro/runtime/monitor.mjs tests/monitor.test.mjs
git commit -m "feat: add runtime/monitor.mjs live dashboard aggregator

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: thread an `onProgress` sink through `spawn` / `spawnAll`

**Files:**
- Modify: `extensions/ghcp-maestro/runtime/spawn.mjs` (the `adapter.invoke` call ~line 75; `spawnAll` per-spec opts ~lines 133-140; the `opts` JSDoc ~lines 117-122 and the `invoke` typedef ~line 34)
- Test: `tests/spawn-progress.test.mjs`

**Interfaces:**
- Consumes: the `Partial progress` shape an adapter emits via `ctx.onProgress`.
- Produces: `spawn(spec, { ..., onProgress })` and `spawnAll(specs, { ..., onProgress })`
  where `onProgress(evt: ProgressEvent)` is called with enriched
  `{ agent, specId, state, bytes?, tool?, ts }`. The adapter receives
  `ctx.onProgress(partial)`.

- [ ] **Step 1: Write the failing test**

Create `tests/spawn-progress.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnAll } from "../extensions/ghcp-maestro/runtime/spawn.mjs";

// An adapter that emits one progress partial then resolves.
function emittingAdapter(partial) {
  return {
    name: "emitting",
    async invoke(spec, ctx) {
      ctx.onProgress?.(partial);
      return { text: `done:${spec.agent}` };
    },
  };
}

test("spawn enriches adapter progress with agent, specId and ts", async () => {
  const seen = [];
  await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    { adapter: emittingAdapter({ state: "streaming", bytes: 12 }), onProgress: (e) => seen.push(e) },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].specId, "e0");
  assert.equal(seen[0].agent, "alpha");
  assert.equal(seen[0].state, "streaming");
  assert.equal(seen[0].bytes, 12);
  assert.equal(typeof seen[0].ts, "number");
});

test("spawn works when no onProgress sink is provided", async () => {
  const res = await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    { adapter: emittingAdapter({ state: "running" }) },
  );
  assert.equal(res.status, "ok");
});

test("an onProgress sink that throws never breaks spawn", async () => {
  const res = await spawn(
    { id: "e0", agent: "alpha", prompt: "p" },
    {
      adapter: emittingAdapter({ state: "running" }),
      onProgress: () => { throw new Error("monitor blew up"); },
    },
  );
  assert.equal(res.status, "ok");
});

test("spawnAll forwards onProgress to each spec", async () => {
  const seen = [];
  await spawnAll(
    [
      { id: "e0", agent: "alpha", prompt: "p" },
      { id: "e1", agent: "beta", prompt: "p" },
    ],
    { adapter: emittingAdapter({ state: "running" }), onProgress: (e) => seen.push(e.specId) },
  );
  assert.deepEqual(seen.sort(), ["e0", "e1"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/spawn-progress.test.mjs`
Expected: FAIL — `seen.length` is 0 (spawn does not pass `ctx.onProgress` yet).

- [ ] **Step 3: Write the minimal implementation**

In `extensions/ghcp-maestro/runtime/spawn.mjs`, replace the `adapter.invoke` call
(currently `const output = await adapter.invoke(spec, { signal: timeoutCtx.signal });`):

```js
    const onProgress = opts.onProgress
      ? (partial) => {
          try {
            opts.onProgress({
              ...partial,
              agent: spec.agent ?? null,
              specId: spec.id,
              ts: Date.now(),
            });
          } catch {
            // monitoring is best-effort: never let it break the spawn
          }
        }
      : undefined;
    const output = await adapter.invoke(spec, { signal: timeoutCtx.signal, onProgress });
```

In `spawnAll`, add `onProgress` to the per-spec `spawn` opts:

```js
  const tasks = specs.map(
    (spec) => () =>
      spawn(spec, {
        adapter: opts.adapter,
        signal: opts.signal,
        runHandle: opts.runHandle,
        onProgress: opts.onProgress,
      }),
  );
```

Update the `invoke` typedef (~line 34) and the `opts` JSDoc blocks to document the
new optional fields:

```js
 * @property {(spec: AgentSpec, ctx: { signal?: AbortSignal, onProgress?: (partial: object) => void }) => Promise<unknown>} invoke
```

and add `onProgress?: (evt: object) => void,` to both the `spawn` and `spawnAll`
`opts` JSDoc.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/spawn-progress.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm run check`
Expected: ESLint clean; all tests pass (existing spawn tests + the 4 new ones).

- [ ] **Step 6: Commit**

```bash
git add extensions/ghcp-maestro/runtime/spawn.mjs tests/spawn-progress.test.mjs
git commit -m "feat: thread onProgress sink through spawn/spawnAll

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: child-session event normalization + subscription in the standalone adapter

**Files:**
- Modify: `extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs`
  (add two exports; wire `subscribeProgress` into `invoke` after `createSession`,
  unsubscribe in `finally`)
- Test: `tests/standalone-progress.test.mjs`

**Interfaces:**
- Consumes: raw `CopilotSession` events (`{ type, data, ... }`) and `ctx.onProgress`
  from Task 2.
- Produces:
  - `normalizeChildEvent(event) => Partial progress | null`
  - `subscribeProgress(session, onProgress) => () => void` (unsubscribe)

- [ ] **Step 1: Write the failing test**

Create `tests/standalone-progress.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChildEvent,
  subscribeProgress,
} from "../extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs";

test("normalizeChildEvent maps streaming deltas to bytes", () => {
  const p = normalizeChildEvent({
    type: "assistant.streaming_delta",
    data: { totalResponseSizeBytes: 4096 },
  });
  assert.deepEqual(p, { state: "streaming", bytes: 4096 });
});

test("normalizeChildEvent maps tool start to a tool state", () => {
  const p = normalizeChildEvent({ type: "tool.execution_start", data: { toolName: "read" } });
  assert.deepEqual(p, { state: "tool", tool: "read" });
});

test("normalizeChildEvent maps usage to a token delta", () => {
  const p = normalizeChildEvent({
    type: "assistant.usage",
    data: { inputTokens: 800, outputTokens: 200 },
  });
  assert.deepEqual(p, { state: "running", tokens: 1000 });
});

test("normalizeChildEvent tolerates partial usage fields", () => {
  assert.deepEqual(
    normalizeChildEvent({ type: "assistant.usage", data: { outputTokens: 50 } }),
    { state: "running", tokens: 50 },
  );
});

test("normalizeChildEvent maps run-ish lifecycle events to running", () => {
  for (const type of ["subagent.started", "assistant.turn_start", "tool.execution_complete"]) {
    assert.deepEqual(normalizeChildEvent({ type }), { state: "running" });
  }
});

test("normalizeChildEvent ignores unrelated events", () => {
  assert.equal(normalizeChildEvent({ type: "session.idle" }), null);
  assert.equal(normalizeChildEvent(undefined), null);
});

test("subscribeProgress forwards normalized events and returns an unsub", () => {
  let handler;
  let unsubscribed = false;
  const fakeSession = {
    on(h) { handler = h; return () => { unsubscribed = true; }; },
  };
  const seen = [];
  const unsub = subscribeProgress(fakeSession, (p) => seen.push(p));
  handler({ type: "assistant.streaming_delta", data: { totalResponseSizeBytes: 10 } });
  handler({ type: "session.idle" }); // ignored
  assert.deepEqual(seen, [{ state: "streaming", bytes: 10 }]);
  unsub();
  assert.equal(unsubscribed, true);
});

test("subscribeProgress is a no-op without onProgress or session.on", () => {
  assert.equal(typeof subscribeProgress(null, () => {}), "function");
  assert.equal(typeof subscribeProgress({ on() { return () => {}; } }, null), "function");
});

test("a throwing onProgress never escapes the event handler", () => {
  let handler;
  const fakeSession = { on(h) { handler = h; return () => {}; } };
  subscribeProgress(fakeSession, () => { throw new Error("boom"); });
  assert.doesNotThrow(() => handler({ type: "assistant.turn_start" }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/standalone-progress.test.mjs`
Expected: FAIL — `normalizeChildEvent`/`subscribeProgress` are not exported.

- [ ] **Step 3: Write the minimal implementation**

In `extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs`, add near the
bottom (next to `extractText`):

```js
/**
 * Translate a raw child CopilotSession event into a normalized progress partial,
 * or null when the event is not progress-relevant.
 * @param {{ type?: string, data?: any }} event
 * @returns {{ state: string, bytes?: number, tool?: string, tokens?: number } | null}
 */
export function normalizeChildEvent(event) {
  switch (event?.type) {
    case "subagent.started":
    case "assistant.turn_start":
    case "tool.execution_complete":
      return { state: "running" };
    case "assistant.streaming_delta":
      return { state: "streaming", bytes: event.data?.totalResponseSizeBytes };
    case "tool.execution_start":
      return { state: "tool", tool: event.data?.toolName };
    case "assistant.usage": {
      const tokens = (event.data?.inputTokens ?? 0) + (event.data?.outputTokens ?? 0);
      return { state: "running", tokens };
    }
    default:
      return null;
  }
}

/**
 * Subscribe to a child session's events and forward normalized progress to
 * `onProgress`. Returns an unsubscribe function. Best-effort: a throwing sink is
 * swallowed, and a missing session/sink yields a no-op unsubscribe.
 * @param {{ on?: Function }} session
 * @param {(partial: object) => void} onProgress
 * @returns {() => void}
 */
export function subscribeProgress(session, onProgress) {
  if (!onProgress || typeof session?.on !== "function") return () => {};
  return session.on((event) => {
    const partial = normalizeChildEvent(event);
    if (!partial) return;
    try {
      onProgress(partial);
    } catch {
      // monitoring is best-effort; never disturb the child session
    }
  });
}
```

Then wire it into `invoke`. After `const childSession = await client.createSession({...});`
and before the `try {` that calls `sendAndWait`, add:

```js
      const unsubscribeProgress = subscribeProgress(childSession, ctx?.onProgress);
```

and in the existing `finally` block, unsubscribe before disconnecting:

```js
      } finally {
        try {
          unsubscribeProgress();
        } catch {
          // ignore
        }
        try {
          await childSession.disconnect?.();
        } catch (err) {
          await logger?.warn?.(
            `standalone-client: childSession.disconnect failed: ${err?.message ?? err}`,
          );
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/standalone-progress.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Syntax-check the touched adapter (it imports the SDK lazily)**

Run: `node --check extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs tests/standalone-progress.test.mjs
git commit -m "feat: emit child-session progress from the standalone adapter

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: wire the monitor into the workflow runners

**Files:**
- Modify: `extensions/ghcp-maestro/extension.mjs`
  - import `createMonitor`
  - add `monitorEnabled(env)` helper next to `isTruthyEnv`
  - in `runTaskWorkflow`, `runBrainstormWorkflow`, `runHelloWorkflow`: create a
    monitor, `seed` the explore specs, pass `onProgress` into the explore
    `spawnAll`, `settle` each result, and `flush`.
- Test: extend `tests/plan-parse.test.mjs` is NOT appropriate; instead add a tiny
  unit test for the pure helper in a new file `tests/monitor-enabled.test.mjs`.

**Interfaces:**
- Consumes: `createMonitor` (Task 1), `spawnAll({ onProgress })` (Task 2).
- Produces: `monitorEnabled(env: object) => boolean` (exported for test) — `false`
  when `GHCP_MAESTRO_NO_MONITOR` is truthy, else `true`.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-enabled.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorEnabled } from "../extensions/ghcp-maestro/extension.mjs";

test("monitoring is on by default", () => {
  assert.equal(monitorEnabled({}), true);
});

test("GHCP_MAESTRO_NO_MONITOR opts out", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: v }), false, v);
  }
});

test("a non-truthy opt-out value leaves monitoring on", () => {
  assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: "0" }), true);
  assert.equal(monitorEnabled({ GHCP_MAESTRO_NO_MONITOR: "" }), true);
});
```

> Note: importing `extension.mjs` runs its top-level `joinSession(...)`. If that
> import has side effects that fail under `node --test`, instead extract
> `monitorEnabled` (and `isTruthyEnv`) into a tiny `runtime/env-flags.mjs` and
> import from there in both `extension.mjs` and the test. Prefer the extraction
> if the direct import is not already test-safe (check how
> `tests/plan-parse.test.mjs` imports from the runtime, which is side-effect-free).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/monitor-enabled.test.mjs`
Expected: FAIL — `monitorEnabled` not exported (or import side-effects → use the
`runtime/env-flags.mjs` extraction noted above, then re-run).

- [ ] **Step 3: Write the minimal implementation**

If extraction is needed, create `extensions/ghcp-maestro/runtime/env-flags.mjs`:

```js
/** Loose truthy check for opt-in/opt-out env flags (1/true/yes/on). */
export function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/** Monitoring is on unless GHCP_MAESTRO_NO_MONITOR is truthy. */
export function monitorEnabled(env = {}) {
  return !isTruthyEnv(env.GHCP_MAESTRO_NO_MONITOR);
}
```

Then in `extension.mjs`: import `createMonitor` and (if extracted) `monitorEnabled`,
replacing the local `isTruthyEnv` with the imported one. Otherwise add
`monitorEnabled` next to the existing `isTruthyEnv` and `export` both.

Add imports at the top of `extension.mjs`:

```js
import { createMonitor } from "./runtime/monitor.mjs";
```

In each runner, wrap the explore `spawnAll`. For `runTaskWorkflow` the explore
fan-out is `const exploreResults = await spawnAll(exploreSpecs, { adapter, runHandle: run });`.
Replace it with:

```js
  const monitor = monitorEnabled(process.env)
    ? createMonitor({
        label: `ghcp-maestro/${runId} explore`,
        render: (text) => session.log(text, { ephemeral: true }),
      })
    : null;
  monitor?.seed(exploreSpecs.map((s) => ({ id: s.id, agent: s.agent })));
  const t1 = Date.now();
  const exploreResults = await spawnAll(exploreSpecs, {
    adapter,
    runHandle: run,
    onProgress: monitor ? (e) => monitor.onProgress(e) : undefined,
  });
  for (const r of exploreResults) monitor?.settle(r.spec.id, r.status === "ok");
  monitor?.flush();
```

(Keep the existing `const t1 = Date.now();` — do not duplicate it; the snippet
above shows where it sits. Adjust to the existing variable name in each runner:
`runBrainstormWorkflow` and `runHelloWorkflow` use `specs`/their own spec arrays
and `results`; apply the same four lines — `seed`, `onProgress`, `settle`,
`flush` — around their explore `spawnAll`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/monitor-enabled.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Syntax-check + full gate**

Run: `node --check extensions/ghcp-maestro/extension.mjs && npm run check`
Expected: no syntax error; ESLint clean; all tests pass.

- [ ] **Step 6: Manual smoke (optional, requires a live host)**

Run a real task with the extension installed and confirm a refreshing
`ghcp-maestro/<runId> explore …` block appears during the fan-out, and that
`GHCP_MAESTRO_NO_MONITOR=1` suppresses it.

- [ ] **Step 7: Commit**

```bash
git add extensions/ghcp-maestro/extension.mjs extensions/ghcp-maestro/runtime/env-flags.mjs tests/monitor-enabled.test.mjs
git commit -m "feat: render a live fan-out dashboard in task/brainstorm/hello

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: documentation

**Files:**
- Modify: `docs/CHANGELOG.md` (add an "Added" entry under `[Unreleased]`)
- Modify: `README.md`, `README.ko.md` (one feature bullet each)

**Interfaces:** none.

- [ ] **Step 1: Update the changelog**

Under `## [Unreleased]` → `### Added`, prepend:

```markdown
- **Real-time in-TUI monitoring (issue #2).** New `runtime/monitor.mjs`
  aggregates per-agent fan-out progress into a compact dashboard rendered via
  throttled ephemeral host logs. The standalone adapter now subscribes to each
  child session's events (`subagent.*`, `tool.execution_*`,
  `assistant.streaming_delta`) and forwards them through an `onProgress` sink
  threaded by `spawn`/`spawnAll`. On by default for `task`/`brainstorm`/`hello`;
  opt out with `GHCP_MAESTRO_NO_MONITOR=1`. Monitoring is best-effort and never
  affects fan-out results. New unit tests: `tests/monitor.test.mjs`,
  `tests/spawn-progress.test.mjs`, `tests/standalone-progress.test.mjs`,
  `tests/monitor-enabled.test.mjs`.
```

- [ ] **Step 2: Update both READMEs**

In `README.md`, add a feature bullet:

```markdown
**Live progress in the TUI.**
While a run fans out, ghcp-maestro shows a refreshing dashboard of each agent's
state and elapsed time right in the session. Opt out with
`GHCP_MAESTRO_NO_MONITOR=1`.
```

In `README.ko.md`, add the mirror:

```markdown
**TUI 안의 실시간 진행 상황.**
run 이 fan-out 되는 동안, 각 에이전트의 상태와 경과 시간을 세션 안에서 새로고침
되는 대시보드로 보여준다. `GHCP_MAESTRO_NO_MONITOR=1` 로 끌 수 있다.
```

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md README.md README.ko.md
git commit -m "docs: document real-time in-TUI run monitoring

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage:**
- Goal "live per-agent state + elapsed + bytes" → Task 1 (formatter) + Task 3
  (bytes from `assistant.streaming_delta`). ✓
- "Natural in-TUI via ephemeral logs" → Task 4 renders with
  `session.log(text, { ephemeral: true })`. ✓
- "Zero deps, session.log-only" → all tasks; Global Constraints. ✓
- "Degrade gracefully / non-interfering" → best-effort try/catch in Tasks 1–3;
  `monitorEnabled` opt-out in Task 4. ✓
- "Testable: pure aggregator + fake clock; normalization with fake emitter" →
  Tasks 1 and 3. ✓
- "Per-phase token totals (design §2 / §4b)" → `tokens` threaded through the
  Partial/ProgressEvent contracts, accumulated in Task 1's monitor, and sourced
  from `assistant.usage` in Task 3's `normalizeChildEvent`. ✓
- Phasing: this plan is v1 (Approach A + token totals). The v2 `/workflows`-parity
  items — drill-down, pause/stop/restart, and the optional Canvas panel — are
  intentionally out of scope here (see design §11). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step
has complete code. ✓

**Type consistency:** `onProgress(partial)` (adapter side) vs enriched
`ProgressEvent` (monitor side) are distinguished consistently; `createMonitor`
method names (`seed`/`onProgress`/`settle`/`flush`/`format`) match between Task 1
and Task 4; `normalizeChildEvent`/`subscribeProgress` names match between Task 3
definition and its test. ✓

## Execution Handoff

This plan is intentionally **not executed yet** — issue #2 tracks it for a future
session. When picking it up, choose:

1. **Subagent-Driven (recommended)** — REQUIRED SUB-SKILL:
   superpowers:subagent-driven-development. Fresh subagent per task + review
   between tasks.
2. **Inline Execution** — REQUIRED SUB-SKILL: superpowers:executing-plans. Batch
   execution with checkpoints.
