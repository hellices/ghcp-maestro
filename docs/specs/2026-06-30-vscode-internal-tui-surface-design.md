# VS Code Internal TUI Surface Design for ghcp-maestro

Date: 2026-06-30
Status: Approved (conversation-level), ready for implementation planning

## 1) Problem and goals

Current ghcp-maestro is optimized for GHCP CLI runtime (`/maestro` on GHCP). The user wants the same command surface to run in VS Code Chat, with a stronger visual/TUI-like monitoring experience and deep interactive drill-down per agent, all inside VS Code.

Goals:
- Keep `/maestro` command mental model aligned across GHCP and VS Code.
- Deliver an in-VS Code operations surface (no external browser).
- Show high-density, terminal-like run visibility (phase/agent/progress/cost/time).
- Enable interactive per-agent inspection (prompt, output, tools, retries, errors).
- Reuse existing runtime core to avoid behavior drift.

Non-goals:
- Replacing GHCP surface.
- Rewriting runtime orchestration logic.
- Building a standalone desktop/web dashboard.

## 2) Recommended approach

Adopt **Shared Core + Dual Surface Adapters**.

- Keep `extensions/ghcp-maestro/runtime/*` as shared orchestration core.
- Keep GHCP extension entrypoint unchanged as one surface.
- Add a VS Code extension package as a second surface:
  - Chat participant for `/maestro`-style invocation
  - TreeView for run/phase/agent hierarchy
  - Webview panel for TUI-like timeline and details

Why this approach:
- Preserves tested runtime behavior and avoids duplicate logic.
- Enables richer VS Code-native UX where GHCP SDK constraints exist.
- Minimizes long-term maintenance and feature drift risk.

## 3) Target UX (VS Code internal only)

### 3.1 Interaction entry
- User triggers via VS Code Chat participant (`/maestro`-compatible subcommands).
- Chat confirms run creation and opens/focuses monitoring view.

### 3.2 Monitoring surfaces
- **Activity Bar TreeView (Maestro Runs)**:
  - `Run -> Phase -> Agent` hierarchy
  - state icons: queued/running/success/failure/stopped
  - compact progress counters (`3/10`, `28/35`)
- **Panel Webview (Maestro Console)**:
  - left: phases list (TUI-style density)
  - right: selected phase agent table
  - header: run summary (elapsed, counts, token/tool aggregates)
  - bottom tabs: `Timeline | Agent Detail | Tool Trace | Output`

### 3.3 Drill-down and controls
- click phase -> filter agent list
- click agent -> detail pane with:
  - original prompt
  - final output / error
  - tool call timeline (start/end/duration/status)
  - token/tool stats
- actions:
  - retry failed agent
  - open full raw log
  - copy spec/output

### 3.4 Hard UX constraints
- No external browser windows.
- All interactions inside VS Code workbench.
- Keyboard-friendly navigation and dense visual layout preferred.

## 4) Architecture

## 4.1 Shared runtime (existing)
- `spawn/spawnAll`, plan decomposition, run store, quality helpers remain in shared core.
- Shared core remains adapter-driven and surface-agnostic.
- Shared core must not import VS Code APIs or GHCP session objects directly.

## 4.2 New VS Code adapter layer
- `UiSinkAdapter`: emits normalized events to TreeView/Webview.
- `LoggerAdapter`: maps runtime logs to both chat stream and run timeline model.
- `CancellationAdapter`: binds VS Code cancellation tokens to run lifecycle.
- Adapters are the only place allowed to translate between core-domain events and VS Code UI primitives.

## 4.3 VS Code surface modules
- `vscode-extension/src/extension.ts` (activation and registrations)
- `chat/participant.ts` (command parse/dispatch)
- `views/runsTreeProvider.ts` (Activity Bar tree)
- `panel/consoleWebview.ts` (run console panel)
- `state/runViewModel.ts` (UI state projection from run-store + runtime events)

## 4.4 Interface-first contract (must-have)

Implementation must begin from explicit interfaces and dependency direction:

- `core -> ports (interfaces)` only
- `adapters -> implement ports`
- `surface -> composes core + adapters`

Reference contracts (names may vary, separation intent is mandatory):

```ts
interface RuntimePort {
  runCommand(input: MaestroCommandInput): Promise<RunHandle>;
  resumeRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
}

interface UiSinkPort {
  onRunEvent(event: RunUiEvent): void;
}

interface LogPort {
  info(message: string): Promise<void> | void;
  warn(message: string): Promise<void> | void;
  error(message: string): Promise<void> | void;
}

interface CancellationPort {
  isCancelled(): boolean;
  onCancel(cb: () => void): void;
}
```

Design rules:
- No reverse dependency (`core` must not depend on `vscode-extension/*`).
- No implicit shared mutable state between adapters.
- Event payload schema must be versioned or strictly typed at one boundary.
- New surface (future GHCP/other IDE) should be addable by implementing ports only.

## 5) Data flow

1. Chat participant parses `/maestro <subcommand>`.
2. Dispatch enters shared runtime workflow.
3. Runtime emits progress/events through `UiSinkAdapter`.
4. `runViewModel` updates:
   - TreeView nodes (hierarchy/status)
   - Webview model (table/timeline/detail)
5. User selection events from Tree/Webview drive focused queries into run model.
6. Retry action sends a scoped runtime command (agent-level rerun where supported).

## 6) Error handling and resilience

- Event bridge failures must surface as explicit UI warnings (no silent drops).
- If Webview is closed, processing continues; state persists via run-store.
- Reopen panel restores current run snapshot from run-store.
- Retry failures remain attached to the same run timeline with explicit markers.
- Partial data (e.g., missing token metadata) should render as `unknown` fields, not hidden.
- Contract violations between core/adapters must throw explicit typed errors and be surfaced in UI.

## 7) Performance and scalability constraints

- Target: up to 1,000 agents/run (global runtime cap already defined).
- UI strategy:
  - virtualized rendering for long agent lists
  - incremental updates (batch every short interval)
  - avoid full-panel rerender on each event
- Preserve responsiveness during high-frequency event bursts.

## 8) Testing strategy

### 8.1 Unit tests
- Chat command parser behavior parity (`task`, `brainstorm`, `run`, `workflows`, etc.)
- view-model reducers for event -> UI state transitions
- adapter mapping correctness (runtime event to UI event)

### 8.2 Integration tests
- run creation and live updates reflected in TreeView/Webview
- selection drill-down accuracy for phase and agent
- retry action flow with success/failure cases

### 8.3 Manual acceptance checks
- VS Code only workflow end-to-end (no browser)
- TUI-like panel density and readability
- agent-level details visible and interactable during active runs

## 9) Rollout plan (high level)

1. Scaffold `vscode-extension/` package and activation wiring.
2. Implement chat participant + shared command routing.
3. Implement TreeView baseline.
4. Implement Webview console baseline.
5. Wire runtime event bridge and live updates.
6. Add drill-down/retry interactions.
7. Optimize rendering and finalize UX polish.

## 10) Open decisions to lock in implementation plan

- Exact VS Code command/participant naming and discoverability text.
- Retry granularity policy (single agent only vs phase subset).
- Detail panel default tab and fallback behavior for incomplete telemetry.
- Final interface package location (`runtime/ports/*` vs dedicated `shared-contracts/`).
