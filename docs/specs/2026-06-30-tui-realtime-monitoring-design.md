# Design — Real-time in-TUI run monitoring

- Status: **Draft / proposed** — tracked as [issue #2](https://github.com/hellices/ghcp-maestro/issues/2); not yet implemented.
- Implementation plan: [2026-06-30-tui-realtime-monitoring-plan.md](2026-06-30-tui-realtime-monitoring-plan.md)
- Date: 2026-06-30
- Scope: surface live progress of a ghcp-maestro fan-out inside the host Copilot
  CLI TUI, naturally, while the run is in flight.

---

## 1. Problem

Today `/maestro task|brainstorm|hello` fan out N isolated child Copilot sessions
in parallel, but the host only emits coarse `session.log` lines **after** each
phase finishes (e.g. `phase=explore wall-clock=63000ms`). During the
often-minute-plus fan-out the user sees nothing about which agents are running,
which have finished, or how far along they are. The ask: let the user **watch
real-time progress in the TUI, naturally**, without leaving the session.

## 2. Goals

- Live, in-TUI view of an in-flight run: per-agent state (pending → running →
  done/failed), elapsed time, and a phase/overall summary.
- "Natural" — rendered in the normal Copilot CLI TUI, no separate window required.
- Zero new runtime dependencies; `session.log()`-only output discipline preserved.
- Degrades gracefully on hosts/modes that don't support richer surfaces.
- Negligible overhead and no interference with the actual fan-out results.

## 3. Non-goals

- A separate desktop/web dashboard or external process (that is the opposite of
  "in-TUI"; explicitly out of scope here).
- Historical analytics across runs (the existing `/maestros` + RunStore already
  cover after-the-fact inspection).
- Interactive control (pause/kill individual agents) — monitoring only for v1.

## 4. Research findings (SDK facts that make this feasible)

Verified against the installed `@github/copilot-sdk` type definitions
(`copilot-sdk/session.d.ts`, `types.d.ts`, `generated/session-events.d.ts`):

- Each child session created by `standalone-client.mjs` is a full
  `CopilotSession` and exposes `session.on(eventType, handler)`.
- The event stream is rich and already includes everything we need for progress:
  - `subagent.started` / `subagent.completed` / `subagent.failed`
  - `tool.execution_start` / `tool.execution_progress` / `tool.execution_complete`
  - `assistant.streaming_delta` (carries a cumulative byte count), plus
    `assistant.message_delta`, `assistant.turn_start` / `assistant.turn_end`
  - `session.idle` (turn finished)
- The host session can emit **ephemeral** log lines:
  `session.log(text, { ephemeral: true })` — transient status that is not
  persisted to the event log, ideal for a refreshing status block.
- A richer, **experimental** surface exists: canvases
  (`session.capabilities.ui?.canvases`, `joinSession({ canvases: [createCanvas(...)] })`),
  which can render host UI panels.
- Today's `standalone-client.mjs` does **not** subscribe to any child events; it
  only calls `sendAndWait`. So there is no progress signal flowing yet — that is
  the core gap this feature fills.

## 5. Approaches considered

### A. Ephemeral live status block via `session.log({ ephemeral: true })` — RECOMMENDED

The spawn layer gains an optional `onProgress` sink. The standalone adapter
subscribes to its child session's events, normalizes them to a small progress
record (`{ agent, state, bytes, elapsed }`), and calls `onProgress`. A new
`runtime/monitor.mjs` aggregates progress across all in-flight agents into a
compact dashboard string and renders it via throttled ephemeral host logs.

- Pros: most "natural in-TUI"; zero deps; works wherever ephemeral logs render;
  trivially degrades (fall back to periodic non-ephemeral summaries or silence);
  fully unit-testable (pure aggregator + fake clock).
- Cons: "visual" is a refreshing text block (a small table / progress line), not
  a graphical panel.

### B. Canvas dashboard panel (`capabilities.ui?.canvases`)

Register a `maestro-monitor` canvas via `joinSession({ canvases: [...] })`; open
it on run start, push live updates, close on completion.

- Pros: richest fidelity (a real panel, progress bars possible).
- Cons: **experimental wire protocol** (may change or be removed); capability-gated
  (absent on many hosts); the render/open contract is heavier and less defined;
  higher risk for a feature meant to be production-stable.

### C. External sidecar / web UI

Spawn a local HTTP server + browser dashboard (or a second TUI process) tailing
the RunStore.

- Pros: most powerful and fully decoupled.
- Cons: not in-TUI, heaviest, new moving parts; contradicts the "naturally,
  in-TUI" requirement. Rejected for this feature.

## 6. Recommendation

Ship **A** as the core (v1). Keep **B** as an optional, capability-gated
enhancement layered on the same progress stream later (v2). **C** is out of scope.

Rationale: A delivers the requested "natural real-time in-TUI" experience with
the lowest risk, no new dependencies, and clean testability, while reusing the
exact event stream B would later consume — so v2 is additive, not a rewrite.

## 7. Architecture (Approach A)

```
child CopilotSession events
   │  (subagent.*, tool.execution_*, assistant.streaming_delta, session.idle)
   ▼
standalone-client.mjs  ── normalize ──▶  ctx.onProgress({ agent, state, bytes, ts })
   ▼
spawn.mjs (spawn/spawnAll forward an onProgress sink to the adapter)
   ▼
runtime/monitor.mjs  ── aggregate per-agent state + throttle ──▶  render(text)
   ▼
extension.mjs  ── render = session.log(text, { ephemeral: true })  ──▶  TUI
```

### Components

- **`runtime/spawn.mjs`** — `spawn`/`spawnAll` accept `onProgress` in opts and
  pass an event sink to the adapter via `ctx.onProgress`. No behavior change when
  the sink is absent.
- **`runtime/adapters/standalone-client.mjs`** — subscribe to the child session's
  relevant events; translate each to a normalized `ProgressEvent`; call
  `ctx.onProgress`. Unsubscribe in `finally`. Handlers are wrapped so a monitor
  error can never break `sendAndWait`.
- **`runtime/monitor.mjs`** (new) — `createMonitor({ render, now, throttleMs })`
  maintains per-agent state (`pending|running|streaming|done|failed`, bytes,
  start/elapsed), renders a compact dashboard string, and calls `render` at most
  once per `throttleMs` (plus a final flush). Pure and deterministic: inject a
  fake `now` clock and capture `render` calls in tests.
- **`extension.mjs`** — each workflow runner creates a monitor whose `render`
  calls `session.log(text, { ephemeral: true })`, gated on an opt-out env
  (`GHCP_MAESTRO_NO_MONITOR`) and a safe fallback when ephemeral logging is not
  available; wires `onProgress` into its `spawnAll` calls.

### Dashboard (illustrative)

```
ghcp-maestro/<runId> · explore 3/5 done · 00:42
  ✓ user-value-analysis      done    19.2s
  ✓ technical-feasibility    done    14.9s
  ⠿ alternatives-comparison  stream  41.0s  3.4KB
  ⠿ maintenance-cost         run     41.0s
  · strategic-fit            pending
```

## 8. Data flow & throttling

child events → adapter normalizes → `ctx.onProgress` → monitor aggregates →
throttled `render` → host ephemeral log → TUI. Throttle (default ~500ms) coalesces
high-frequency `assistant.streaming_delta` events to avoid log spam / JSON-RPC
pressure; state transitions (start/done/failed) flush promptly.

## 9. Error handling

- Event subscription must never affect the real `sendAndWait`: all monitor/handler
  callbacks are wrapped in try/catch and failures are swallowed (optionally logged
  once).
- If ephemeral logging is unsupported, fall back to occasional concise
  non-ephemeral summaries, or silence — never crash the run.
- Monitor is best-effort and additive; a monitor failure degrades to today's
  behavior (coarse per-phase logs).

## 10. Testing

- `monitor.mjs`: unit-test aggregation + throttle + final flush with a fake clock
  and a captured `render` sink (deterministic, no live model).
- Adapter normalization: unit-test the raw-SDK-event → `ProgressEvent` mapping
  with a fake child-session emitter (no real CLI).
- No live-model tests (consistent with the rest of the suite).

## 11. Phasing

- **Phase 1 (v1):** `spawn` `onProgress` plumbing + `runtime/monitor.mjs` +
  adapter event subscription + ephemeral dashboard wired into
  `task` / `brainstorm` / `hello`. Unit tests for the monitor and the
  normalization. Docs + CHANGELOG.
- **Phase 2 (v2, optional):** Canvas-based panel behind
  `capabilities.ui?.canvases`, consuming the same progress stream.

## 12. Open questions (for the issue / review)

1. Dashboard layout: compact multi-line table (as above) vs a single refreshing
   line. Default throttle interval (500ms?).
2. Show streaming byte/token counts, or just state + elapsed?
3. Default on, with `GHCP_MAESTRO_NO_MONITOR` opt-out — or default off behind an
   opt-in env? (Proposed: on for interactive hosts, off in `-p`/headless.)
4. Is the v2 Canvas panel worth pursuing given its experimental status?
