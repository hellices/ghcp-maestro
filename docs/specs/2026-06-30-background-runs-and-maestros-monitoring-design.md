# Design — Background runs + `/maestros` progress monitoring (v2)

- Status: **Approved (autonomous)** — supersedes the v1 inline dashboard from
  [`2026-06-30-tui-realtime-monitoring-design.md`](2026-06-30-tui-realtime-monitoring-design.md)
  for issue [#2](https://github.com/hellices/ghcp-maestro/issues/2).
- Date: 2026-06-30
- Implements the §11 v2 direction: move the run off the foreground turn and watch
  it from a command, mirroring Claude Code's `/workflows` model (background run +
  on-demand progress view) within our SDK's limits.

## 1. Problem

v1 (PR #6) renders a live dashboard via **ephemeral host logs while the runner
blocks the foreground turn**. Because `/maestro task|brainstorm|hello` is
`await`ed in the command handler, the session is occupied for the whole
minute-plus fan-out and the user cannot do anything else meanwhile.

The user wants the Claude Code shape instead: **kick the run off into the
background so the session stays free, then watch progress from `/maestros`.**

## 2. SDK facts (verified against the installed `@github/copilot-sdk`)

- `CommandHandler = (ctx) => Promise<void> | void` — a handler may return
  immediately and let work continue as a detached promise.
- This repo **already** runs its env-probe workflows fire-and-forget at the top
  level ("not awaited … so joinSession() can return and the host marks the
  extension ready"). The same mechanism drives the existing
  hello/brainstorm/task probes, so **background execution is a proven pattern**
  here — a detached promise keeps running while the session is live.
- `session.log(text, { ephemeral: true })` exists, and `session.ui` elicitation
  is gated on `session.capabilities.ui?.elicitation`.
- Slash commands are **not** an interactive TUI: a `CommandHandler` runs once and
  returns. There is no arrow-key/drill-down surface like Claude's `/workflows`.
  So `/maestros` is a **snapshot view** — each invocation prints the current
  state; re-run it to refresh.

## 3. Approach

Reuse v1's aggregation infra (`monitor.mjs`, `spawn` `onProgress`, the standalone
adapter's `subscribeProgress`) and change only the **wiring**:

1. **Background execution.** Mark long-running subcommands (`task`, `brainstorm`,
   `hello`, `run`) `background: true`. The handler dispatches them
   fire-and-forget (`Promise.resolve(sc.run(tail)).catch(...)`) and returns at
   once; the runner logs `started <runId> — watch with /maestros <runId>` as its
   first line. Short subcommands (`pong`, `workflows`, `help`) stay foreground.
2. **Progress persistence.** The monitor's render sink writes a **snapshot** to
   the run dir (`progress.json`) instead of emitting an ephemeral log. RunStore
   gains `writeProgress(snapshot)` / `readProgress()`; the `logs/` slot reserved
   for "future stream snapshots" is finally used.
3. **`/maestros` snapshot view.**
   - `/maestros` (list): each run keeps its current line; a **running** run gets a
     one-line progress summary (`phase=explore 2/3 done · 00:48`) read from
     `progress.json`.
   - `/maestros <runId>` (detail): print the full dashboard rebuilt from that
     run's `progress.json`.
4. **Drop the inline auto-render.** v1's ephemeral dashboard during the foreground
   fan-out is removed. The aggregation/format logic is kept and reused.
5. **Approval gate unchanged.** The runner body (plan → parse/retry → approval
   gate → explore → synth) is untouched. In the background the gate still calls
   `session.ui` when `capabilities.ui.elicitation` is true (Claude's "confirm
   before the run" moment) and keeps its existing auto-approve fallback when the
   host is non-interactive. Only `task` has a gate; `brainstorm`/`hello` fan out
   directly.

## 4. Components & interfaces

- **`runtime/monitor.mjs`** (modify): the render sink is called as
  `render(text, snapshot)` — a **dual signature** so v1 consumers/tests that take
  only `text` keep working unchanged, while the runner uses the second
  `snapshot` argument. Add `monitor.snapshot()` returning
  `{ label, agents: Array<{ specId, agent, state, elapsedMs, bytes, tokens }>,
  done, total, updatedAt }`. Add pure `renderDashboard(snapshot)` and
  `renderSummary(snapshot)` (one-liner) exports; `monitor.format()` delegates to
  `renderDashboard(this.snapshot())` so v1 tests still describe the same output.
- **`runtime/run-store.mjs`** (modify): `writeProgress(snapshot)` →
  `progress.json` (atomic); `readProgress()` → snapshot | undefined. Exposed on
  the RunHandle next to `writeAgent`/`patchManifest`.
- **`extension.mjs`** (modify):
  - `MAESTRO_SUBCOMMANDS[].background` flag + handler fire-and-forget branch.
  - Each background runner: create the monitor with
    `render: (_text, snap) => run.writeProgress(snap)` (best-effort, never
    awaited in a way that can break the fan-out), `seed`/`onProgress`/`settle`/
    `flush` as in v1, and a `started <runId>` first log line.
  - `/maestros` handler: for each run, append `renderSummary` when
    `progress.json` exists and status is running. Add a `/maestros <runId>`
    branch that prints `renderDashboard`.
- **No new module strictly required**, but `renderDashboard`/`renderSummary` live
  in `monitor.mjs` (pure, exported) so they unit-test without a session.

## 5. Data flow

```
child CopilotSession events
  → subscribeProgress (standalone adapter, normalizeChildEvent)
  → ctx.onProgress(partial)            [spawn enriches: agent/specId/ts]
  → monitor.onProgress(evt)            [aggregate per agent + tokens]
  → render sink (throttled)            [monitor calls render(text, snapshot)]
  → run.writeProgress(snapshot)        [progress.json on disk]

/maestros            → listRuns + readProgress → renderSummary per running run
/maestros <runId>    → openRun + readProgress → renderDashboard
```

## 6. Error handling

- Monitoring stays **best-effort and non-interfering** (v1 invariant): a throwing
  render/`writeProgress` is swallowed; it never changes `spawnAll` results.
- `writeProgress` uses the existing `writeJsonAtomic` (temp dir → rename), so a
  crash mid-write never leaves a partial `progress.json`; `readProgress` tolerates
  a missing file (returns `undefined`).
- Background dispatch wraps the runner in `.catch(failRun-style logging)` so a
  detached rejection can't go unhandled.
- A finished run's `progress.json` reflects the last flushed state; `/maestros`
  shows the terminal manifest status (`complete`/`failed`/`stopped`) alongside it.

## 7. Testing

- `monitor.snapshot()` shape + `renderDashboard`/`renderSummary` strings
  (deterministic clock) — extend `tests/monitor.test.mjs`.
- `writeProgress`/`readProgress` round-trip, missing-file tolerance — extend
  `tests/run-store.test.mjs`.
- `/maestros` summary/detail formatting is covered by the pure renderers above;
  the handler wiring (background dispatch) is validated by a manual smoke note
  (needs a live host) plus `node --check`.

## 8. Out of scope (still v2+/future)

- Real-time auto-refresh of `/maestros` (no interactive TUI surface in the SDK).
- In-view run controls (pause/stop/restart) and agent drill-down — design §11.
  `/maestro-stop <runId>` already marks a run stopped.
- The optional Canvas panel.

## 9. Open questions / risks

1. **Background elicitation.** Whether `session.ui` elicitation behaves well from
   a detached promise is unverified on a live host. Mitigation: the gate code is
   unchanged and already falls back to auto-approve when the host is
   non-interactive; worst case is a confirm dialog appearing for a backgrounded
   `task` run. Flagged for manual smoke.
2. **Throttled disk writes.** `progress.json` is rewritten on each (throttled)
   render. At default 500 ms throttle and ≤16 concurrent agents this is a handful
   of small atomic writes per second — acceptable; revisit only if it shows up.
