# Background runs + `/maestros` monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> subagent-driven-development) to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `/maestro task|brainstorm|hello|run` in the background so the session
stays free, persist per-agent fan-out progress to disk, and view it on demand from
`/maestros`.

**Architecture:** Reuse v1's aggregation infra (`monitor.mjs`, `spawn` `onProgress`,
the standalone adapter's `subscribeProgress`). Change only the wiring: the monitor's
render sink writes a snapshot to `progress.json` (instead of an ephemeral log); the
command handler dispatches long runners fire-and-forget; `/maestros` reads the
snapshots and prints a summary or a full dashboard. Implements
`docs/specs/2026-06-30-background-runs-and-maestros-monitoring-design.md` (issue #2).

**Tech Stack:** Node.js ≥ 20 ESM (`.mjs`), `node:test` + `node:assert/strict`,
`@github/copilot-sdk`. Zero runtime dependencies.

## Global Constraints

- Runtime output via `session.log()` only — never `console.*` or direct stdout.
- ESM only; all artifacts are `.mjs`; `package.json` has `"type": "module"`.
- Zero new runtime dependencies (eslint/etc. stay devDependencies).
- Slash command prefix `maestro`; tool prefix `ghcp_maestro_*` (unchanged here).
- Concurrency: global cap 1000 agents/run, default 16 (unchanged).
- Monitoring is **best-effort and non-interfering**: a monitor / `writeProgress`
  error must never break `sendAndWait` or change `spawnAll` results.
- All run-dir writes go through `writeJsonAtomic` (temp dir → rename); reads
  tolerate a missing file (return `undefined`).
- Run the suite with `npm test` (`node --test tests/*.test.mjs`); full gate is
  `npm run check` (ESLint + tests). Every commit includes the trailer
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File Structure

- Modify `extensions/ghcp-maestro/runtime/run-store.mjs` — add `writeProgress` /
  `readProgress` handle methods and a path-safe standalone `readRunProgress(runId)`.
- Modify `extensions/ghcp-maestro/runtime/monitor.mjs` — add `snapshot()`, pure
  `renderDashboard(snapshot)` / `renderSummary(snapshot)` exports, and a dual
  `render(text, snapshot)` sink signature; `format()` delegates to the renderer.
- Modify `extensions/ghcp-maestro/extension.mjs` — persist progress from the
  runners, drop the ephemeral inline render, add a `background` subcommand flag +
  fire-and-forget dispatch, a `started <runId>` log line, and a `/maestros`
  summary + `/maestros <runId>` detail view.
- Modify `tests/run-store.test.mjs`, `tests/monitor.test.mjs`.
- Modify `docs/CHANGELOG.md`, `README.md`, `README.ko.md`.

## Shared contracts (used across tasks)

**Progress snapshot** (produced by `monitor.snapshot()`, persisted as
`progress.json`, consumed by the renderers and `/maestros`):

```js
{
  label: string,            // e.g. "ghcp-maestro/run-x explore"
  agents: Array<{
    specId: string,
    agent: string,
    state: "pending"|"running"|"streaming"|"tool"|"done"|"failed",
    elapsedMs: number,
    bytes: number,
    tokens: number,
    tool?: string,
  }>,
  done: number,             // count of done|failed
  total: number,
  maxElapsedMs: number,
  totalTokens: number,
  updatedAt: number,
}
```

---

### Task 1: RunStore progress persistence

**Files:**
- Modify: `extensions/ghcp-maestro/runtime/run-store.mjs` (add two handle methods
  in `makeHandle`'s returned object next to `writeAgent`/`readAgent`; add one
  exported function next to `listRuns`)
- Test: `tests/run-store.test.mjs`

**Interfaces:**
- Consumes: existing `writeJsonAtomic`, `readJson`, `assertSafeRunId`.
- Produces:
  - `handle.writeProgress(snapshot): Promise<void>` → writes `progress.json`.
  - `handle.readProgress(): Promise<object|undefined>`.
  - `readRunProgress(runId, { baseDir? }): Promise<object|undefined>` (exported,
    path-safe) — reads `runs/<runId>/progress.json` without needing a manifest.

- [ ] **Step 1: Write the failing test**

Append to `tests/run-store.test.mjs` (it already imports `createRun`; add
`readRunProgress` to the import):

```js
test("writeProgress/readProgress round-trips a snapshot", async () => {
  const run = await createRun({ workflow: "task", args: null, baseDir: await tmpBase() });
  const snap = { label: "x explore", agents: [], done: 0, total: 2, maxElapsedMs: 0, totalTokens: 0, updatedAt: 123 };
  await run.writeProgress(snap);
  assert.deepEqual(await run.readProgress(), snap);
  await run.destroy();
});

test("readProgress is undefined before any write", async () => {
  const run = await createRun({ workflow: "task", args: null, baseDir: await tmpBase() });
  assert.equal(await run.readProgress(), undefined);
  await run.destroy();
});

test("readRunProgress reads a run's progress by id", async () => {
  const baseDir = await tmpBase();
  const run = await createRun({ workflow: "task", args: null, baseDir });
  await run.writeProgress({ done: 1, total: 3 });
  const got = await readRunProgress(run.runId, { baseDir });
  assert.equal(got.done, 1);
  assert.equal(got.total, 3);
  await run.destroy();
});

test("readRunProgress is undefined for an unknown run", async () => {
  assert.equal(await readRunProgress("run-does-not-exist", { baseDir: await tmpBase() }), undefined);
});

test("readRunProgress rejects an unsafe runId", async () => {
  await assert.rejects(() => readRunProgress("../escape", { baseDir: await tmpBase() }));
});
```

> If `tests/run-store.test.mjs` has no `tmpBase()` helper, reuse whatever temp-dir
> pattern the existing tests use (check the top of the file) — match it rather than
> adding a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/run-store.test.mjs`
Expected: FAIL — `run.writeProgress is not a function` / `readRunProgress` not exported.

- [ ] **Step 3: Write the minimal implementation**

In `run-store.mjs`, inside the object returned by `makeHandle`, next to
`readAgent`, add:

```js
    /** Persist the live progress snapshot. Atomic, best-effort. */
    async writeProgress(snapshot) {
      await writeJsonAtomic(join(runDir, "progress.json"), snapshot);
    },

    /** Read the last persisted progress snapshot, or undefined if none. */
    async readProgress() {
      return readJson(join(runDir, "progress.json"));
    },
```

And add a standalone export next to `listRuns`:

```js
/**
 * Read a run's progress snapshot by id without opening its manifest.
 * Path-safe; returns undefined when the run or its progress.json is missing.
 *
 * @param {string} runId
 * @param {{ baseDir?: string }} [opts]
 */
export async function readRunProgress(runId, opts = {}) {
  assertSafeRunId(runId);
  const baseDir = opts.baseDir ?? defaultBaseDir();
  return readJson(join(baseDir, "runs", runId, "progress.json"));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/run-store.test.mjs`
Expected: PASS (existing tests + the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add extensions/ghcp-maestro/runtime/run-store.mjs tests/run-store.test.mjs
git commit -m "feat: persist run progress snapshots in RunStore

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: monitor `snapshot()` + pure renderers + dual render sink

**Files:**
- Modify: `extensions/ghcp-maestro/runtime/monitor.mjs`
- Test: `tests/monitor.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `monitor.snapshot(): Snapshot` (shape in Shared contracts).
  - `renderDashboard(snapshot): string` (exported, pure) — header + per-agent rows.
  - `renderSummary(snapshot): string` (exported, pure) — the header line only.
  - The render sink is now invoked as `render(text, snapshot)`; existing
    one-arg consumers keep working.
  - `monitor.format()` returns `renderDashboard(monitor.snapshot())` (unchanged
    output for v1 tests).

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor.test.mjs`:

```js
test("snapshot captures per-agent state, tokens and totals", () => {
  const { monitor } = harness();
  monitor.seed([{ id: "e0", agent: "alpha" }, { id: "e1", agent: "beta" }]);
  monitor.onProgress({ specId: "e0", state: "streaming", bytes: 2048, tokens: 1500 });
  monitor.settle("e1", true);
  const snap = monitor.snapshot();
  assert.equal(snap.total, 2);
  assert.equal(snap.done, 1); // beta settled
  assert.equal(snap.totalTokens, 1500);
  const alpha = snap.agents.find((a) => a.specId === "e0");
  assert.equal(alpha.state, "streaming");
  assert.equal(alpha.bytes, 2048);
  assert.equal(alpha.tokens, 1500);
  assert.equal(typeof alpha.elapsedMs, "number");
});

test("renderDashboard/renderSummary are pure over a snapshot", () => {
  const snap = {
    label: "run-x explore",
    agents: [{ specId: "e0", agent: "alpha", state: "done", elapsedMs: 1000, bytes: 0, tokens: 0 }],
    done: 1, total: 1, maxElapsedMs: 1000, totalTokens: 0, updatedAt: 0,
  };
  const dash = renderDashboard(snap);
  assert.match(dash, /run-x explore/);
  assert.match(dash, /1\/1 done/);
  assert.match(dash, /alpha/);
  const sum = renderSummary(snap);
  assert.match(sum, /1\/1 done/);
  assert.equal(sum.includes("\n"), false); // one line
});

test("the render sink receives both text and snapshot", () => {
  let t = 1000;
  const calls = [];
  const monitor = createMonitor({
    label: "run-x explore",
    render: (text, snap) => calls.push({ text, snap }),
    now: () => t,
  });
  monitor.seed([{ id: "e0", agent: "alpha" }]);
  monitor.onProgress({ specId: "e0", state: "running" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /alpha/);
  assert.equal(calls[0].snap.total, 1);
  assert.equal(calls[0].snap.agents[0].agent, "alpha");
});
```

Update the import at the top of `tests/monitor.test.mjs`:

```js
import { createMonitor, renderDashboard, renderSummary } from "../extensions/ghcp-maestro/runtime/monitor.mjs";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/monitor.test.mjs`
Expected: FAIL — `renderDashboard`/`renderSummary` not exported; `snapshot` undefined.

- [ ] **Step 3: Write the minimal implementation**

Rewrite the internals of `monitor.mjs` so formatting is pure over a snapshot.
Replace the `doRender`/`maybeRender`/`format` block and the returned object with:

```js
  function snapshot() {
    const t = now();
    const agentsList = [...agents.values()].map((a) => ({
      specId: a.id,
      agent: a.agent,
      state: a.state,
      elapsedMs: t - a.startTs,
      bytes: a.bytes,
      tokens: a.tokens,
      ...(a.tool ? { tool: a.tool } : {}),
    }));
    const done = agentsList.filter((a) => a.state === "done" || a.state === "failed").length;
    const maxElapsedMs = agentsList.reduce((m, a) => Math.max(m, a.elapsedMs), 0);
    const totalTokens = agentsList.reduce((m, a) => m + a.tokens, 0);
    return {
      label,
      agents: agentsList,
      done,
      total: agentsList.length,
      maxElapsedMs,
      totalTokens,
      updatedAt: t,
    };
  }

  function doRender() {
    lastRenderTs = now();
    try {
      const snap = snapshot();
      opts.render(renderDashboard(snap), snap);
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

  return {
    seed(specs) {
      for (const s of specs ?? []) {
        agents.set(s.id, {
          id: s.id, agent: s.agent, state: "pending",
          bytes: 0, tokens: 0, startTs: now(), lastTs: now(),
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
    snapshot,
    format() {
      return renderDashboard(snapshot());
    },
  };
}

/** Pure: render a progress snapshot into the full dashboard (header + rows). */
export function renderDashboard(snap) {
  const rows = snap.agents.map((a) => {
    const glyph = GLYPH[a.state] ?? "·";
    const secs = `${Math.round(a.elapsedMs / 1000)}s`;
    const bytes = a.bytes ? `  ${kb(a.bytes)}` : "";
    const tool = a.state === "tool" && a.tool ? `  (${a.tool})` : "";
    const tok = a.tokens ? `  ${ktok(a.tokens)} tok` : "";
    return `  ${glyph} ${a.agent}  ${a.state}  ${secs}${bytes}${tool}${tok}`;
  });
  return [renderSummary(snap), ...rows].join("\n");
}

/** Pure: render a progress snapshot into a one-line summary (the header). */
export function renderSummary(snap) {
  const tokTotal = snap.totalTokens ? ` · ${ktok(snap.totalTokens)} tok` : "";
  return `${snap.label} · ${snap.done}/${snap.total} done · ${mmss(snap.maxElapsedMs)}${tokTotal}`;
}
```

Remove the now-unused old `format()` function body (the one that used `now()`
inline) — `renderDashboard`/`renderSummary` replace it. Keep `mmss`, `kb`, `ktok`,
`GLYPH` (they are now used by the exported renderers).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/monitor.test.mjs`
Expected: PASS (the original 8 v1 tests + 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add extensions/ghcp-maestro/runtime/monitor.mjs tests/monitor.test.mjs
git commit -m "feat: monitor snapshot() + pure dashboard/summary renderers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: background dispatch + progress persistence + `/maestros` view

**Files:**
- Modify: `extensions/ghcp-maestro/extension.mjs`
- Test: none new (the pure renderers are covered in Task 2; this task is wiring,
  validated by `node --check` + the full suite + a manual smoke note).

**Interfaces:**
- Consumes: `createMonitor`, `renderDashboard`, `renderSummary` (Task 2);
  `readRunProgress` (Task 1); the runner's `run` RunHandle with `writeProgress`.
- Produces: background-dispatched `task`/`brainstorm`/`hello`/`run`; a
  `/maestros` list with per-run progress summaries; a `/maestros <runId>` detail.

- [ ] **Step 1: Update imports**

In `extension.mjs`:

```js
import { createMonitor, renderDashboard, renderSummary } from "./runtime/monitor.mjs";
import { createRun, openRun, listRuns, readRunProgress, defaultBaseDir } from "./runtime/run-store.mjs";
```

(Replace the existing `createMonitor` import line and the existing run-store import
line. `monitorEnabled`/`isTruthyEnv` imports stay.)

- [ ] **Step 2: Switch each runner's monitor sink to persist progress, drop the ephemeral render**

In all three runner monitor blocks (`runHelloWorkflow`, `runBrainstormWorkflow`,
`runTaskWorkflow`), replace the v1 monitor creation:

```js
  const monitor = monitorEnabled(process.env)
    ? createMonitor({
        label: `ghcp-maestro/${runId} explore`,
        render: (text) => session.log(text, { ephemeral: true }),
      })
    : null;
```

with:

```js
  const monitor = monitorEnabled(process.env)
    ? createMonitor({
        label: `ghcp-maestro/${runId} explore`,
        render: (_text, snap) => { run.writeProgress(snap).catch(() => {}); },
      })
    : null;
```

(Leave the `seed` / `onProgress` / `settle` / `flush` lines exactly as they are —
they already feed the monitor. The runner variable is `run` in all three.)

- [ ] **Step 3: Add a `started <runId>` line at the top of each background runner**

In `runTaskWorkflow`, right after `const adapter = getStandaloneAdapter();` and its
existing `session.log(...)` line, the run already logs its start. Add a single
explicit pointer line in each of `runTaskWorkflow`, `runBrainstormWorkflow`,
`runHelloWorkflow`, right after `const runId = run.runId;` (and after the adapter
log where present):

```js
  await session.log(`ghcp-maestro/${runId}: started in background — watch with /maestros ${runId}`);
```

- [ ] **Step 4: Add a `background` flag to the long subcommands + fire-and-forget dispatch**

In `MAESTRO_SUBCOMMANDS`, add `background: true` to the `task`, `brainstorm`,
`hello`, and `run` entries (leave `pong`, `workflows`, `help` foreground). Example
for `task`:

```js
  {
    name: "task",
    needsArg: "task description",
    background: true,
    summary: "Decompose a natural-language task into 3-6 subtasks → run each in an isolated child Copilot session in parallel → synth cross-checks them into a final answer.",
    run: (arg) => runTaskWorkflow(session, arg),
  },
```

Then in the `/maestro` command handler, replace the final `await sc.run(tail);`
with:

```js
        if (sc.background) {
          // Fire-and-forget: return at once so the session stays free while the
          // run fans out. The runner logs the runId and persists progress; watch
          // it with /maestros. A detached rejection is logged, never unhandled.
          Promise.resolve()
            .then(() => sc.run(tail))
            .catch((err) =>
              session.log(`ghcp-maestro: ${sc.name} failed: ${err?.message ?? err}`, { level: "error" }),
            );
          return;
        }
        await sc.run(tail);
```

- [ ] **Step 5: Extend `/maestros` with progress summaries + a `<runId>` detail view**

Replace the `maestros` command handler body. The new handler: with an arg, prints
the detail dashboard for that run; without, lists runs and appends a progress
summary for any still-running run.

```js
      handler: async (ctx) => {
        const arg = (ctx?.args ?? "").trim();
        if (arg) {
          let snap;
          try {
            snap = await readRunProgress(arg);
          } catch (err) {
            await session.log(`ghcp-maestro: cannot read progress for '${arg}': ${err?.message ?? err}`, {
              level: "error",
            });
            return;
          }
          if (!snap) {
            await session.log(`ghcp-maestro: no progress recorded for run '${arg}' (yet)`);
            return;
          }
          await session.log(renderDashboard(snap));
          return;
        }
        const runs = await listRuns({ limit: 20 });
        if (runs.length === 0) {
          await session.log(`ghcp-maestro: no runs yet under ${defaultBaseDir()}`);
          return;
        }
        await session.log(`ghcp-maestro: ${runs.length} recent run(s) (newest first):`);
        for (const m of runs) {
          const argsPreview = m.args ? JSON.stringify(m.args).slice(0, 80) : "";
          await session.log(
            `  ${m.runId}  workflow=${m.workflow}  status=${m.status}  started=${new Date(m.startedAt).toISOString()}${argsPreview ? `  args=${argsPreview}` : ""}`,
          );
          if (m.status === "running") {
            const snap = await readRunProgress(m.runId).catch(() => undefined);
            if (snap) await session.log(`      ${renderSummary(snap)}`);
          }
        }
        await session.log("ghcp-maestro: open a run's live dashboard with /maestros <runId>");
      },
```

- [ ] **Step 6: Update `/maestro help` to mention the detail view**

In `maestroHelp`, change the `/maestros` line to:

```js
  lines.push("  /maestros [runId]             list recent runs, or show one run's live dashboard");
```

- [ ] **Step 7: Syntax check + full gate**

Run: `node --check extensions/ghcp-maestro/extension.mjs && npm run check`
Expected: no syntax error; ESLint clean; all tests pass (Task 1 + Task 2 additions
included).

- [ ] **Step 8: Manual smoke (optional, requires a live host)**

With the extension installed under `copilot --experimental`: run `/maestro task ...`,
confirm the handler returns immediately with a `started … /maestros <runId>` line,
the session stays usable, `/maestros` shows the run with a progress summary, and
`/maestros <runId>` prints the refreshing dashboard. Confirm `GHCP_MAESTRO_NO_MONITOR=1`
suppresses progress persistence (no `progress.json`).

- [ ] **Step 9: Commit**

```bash
git add extensions/ghcp-maestro/extension.mjs
git commit -m "feat: run workflows in background, watch progress from /maestros

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: documentation

**Files:**
- Modify: `docs/CHANGELOG.md` (revise the v1 entry under `[Unreleased]`)
- Modify: `README.md`, `README.ko.md` (revise the v1 feature bullet)

**Interfaces:** none.

- [ ] **Step 1: Update the changelog**

Replace the v1 "Real-time in-TUI monitoring" entry under `## [Unreleased]` →
`### Added` with:

```markdown
- **Background runs + `/maestros` monitoring (issue #2).** `/maestro
  task|brainstorm|hello|run` now dispatch in the background — the handler returns
  immediately with a `started <runId>` pointer and the session stays free while
  the fan-out runs. Per-agent progress (state, elapsed, streamed bytes, per-phase
  token totals) is aggregated by `runtime/monitor.mjs` and persisted to the run
  dir as `progress.json`. Watch it on demand: `/maestros` lists runs with a
  one-line progress summary for any still running, and `/maestros <runId>` prints
  the full dashboard. The standalone adapter subscribes to each child session's
  events (`subagent.*`, `tool.execution_*`, `assistant.streaming_delta`,
  `assistant.usage`) through an `onProgress` sink threaded by `spawn`/`spawnAll`.
  Monitoring is best-effort and never affects fan-out results; opt out with
  `GHCP_MAESTRO_NO_MONITOR=1`. New/updated unit tests across
  `tests/monitor.test.mjs`, `tests/run-store.test.mjs`,
  `tests/spawn-progress.test.mjs`, `tests/standalone-progress.test.mjs`,
  `tests/monitor-enabled.test.mjs`.
```

- [ ] **Step 2: Update both READMEs**

In `README.md`, replace the v1 "Live progress in the TUI." bullet with:

```markdown
**Background runs you can watch.**
`/maestro task|brainstorm|hello` kick off in the background, so the session stays
free while agents fan out. Run `/maestros` to list runs with a live progress
summary, or `/maestros <runId>` for the full per-agent dashboard. Opt out of
progress tracking with `GHCP_MAESTRO_NO_MONITOR=1`.
```

In `README.ko.md`, replace the v1 "TUI 안의 실시간 진행 상황." bullet with:

```markdown
**백그라운드 실행과 모니터링.**
`/maestro task|brainstorm|hello` 는 백그라운드로 시작돼, 에이전트가 fan-out 되는
동안 세션은 계속 자유롭다. `/maestros` 로 실행 목록과 진행 요약을, `/maestros
<runId>` 로 에이전트별 상세 대시보드를 본다. `GHCP_MAESTRO_NO_MONITOR=1` 로 진행
추적을 끌 수 있다.
```

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md README.md README.ko.md
git commit -m "docs: document background runs + /maestros monitoring

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage:**
- Design §3.1 background execution → Task 3 Steps 3–4. ✓
- §3.2 progress persistence (`progress.json`, RunStore methods) → Task 1 + Task 3
  Step 2. ✓
- §3.3 `/maestros` summary + detail → Task 3 Step 5. ✓
- §3.4 drop inline auto-render → Task 3 Step 2 (sink no longer logs ephemerally). ✓
- §3.5 approval gate unchanged → no task touches the gate. ✓
- §4 monitor `snapshot()` + dual render + pure renderers → Task 2. ✓
- §7 testing (monitor snapshot/renderers, RunStore round-trip) → Tasks 1–2; wiring
  via `node --check` + manual smoke → Task 3 Steps 7–8. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step
has complete code. The only non-code step is the optional manual smoke (Task 3
Step 8), explicitly marked optional/live-host. ✓

**Type consistency:** The snapshot shape in Shared contracts matches
`monitor.snapshot()` (Task 2), `renderDashboard`/`renderSummary` inputs (Task 2),
`writeProgress`/`readProgress`/`readRunProgress` payloads (Task 1), and the
`/maestros` consumers (Task 3). Method names (`writeProgress`, `readProgress`,
`readRunProgress`, `snapshot`, `renderDashboard`, `renderSummary`) are identical
across definition and use. ✓

## Execution Handoff

This plan is v2 for issue #2 and supersedes the v1 inline-dashboard wiring on the
same branch (`feat/tui-realtime-monitoring`). Execute with
superpowers:executing-plans (inline, batch with checkpoints) since the tasks are
tightly coupled wiring on one branch.
