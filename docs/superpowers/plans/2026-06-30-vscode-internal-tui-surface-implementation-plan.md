# VS Code Internal TUI Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-internal `/maestro` experience with TUI-like live monitoring and agent drill-down while keeping core runtime shared with GHCP.

**Architecture:** Keep orchestration logic in `extensions/ghcp-maestro/runtime/*` and add explicit ports/adapters between core and surfaces. Implement a separate `vscode-extension/` package that consumes shared runtime via interfaces and renders TreeView + Webview panel. Preserve GHCP behavior by extracting shared command routing and reusing it from both surfaces.

**Tech Stack:** Node.js 20+, ESM `.mjs`, VS Code Extension API, existing `node:test`, existing ESLint config.

## Global Constraints

- Runtime output for GHCP path must continue to use `session.log()` only.
- ESM-only project conventions must be preserved (`.mjs` artifacts, no ad-hoc CJS migration).
- Slash/tool naming conventions stay intact: `/maestro*`, `ghcp_maestro_*`.
- Keep runtime adapter-driven; core must not import VS Code APIs directly.
- Keep zero new runtime deps unless strictly required.
- Preserve concurrency limits: default 16, global cap 1000 agents/run.
- Do not break existing GHCP CLI flow requiring `copilot --experimental`.

---

## File Structure (locked before tasks)

- Create: `vscode-extension/package.json` — VS Code extension manifest and contribution points.
- Create: `vscode-extension/extension.mjs` — activation, command registration, provider wiring.
- Create: `vscode-extension/chat/participant.mjs` — VS Code chat participant dispatch entry.
- Create: `vscode-extension/state/run-view-model.mjs` — runtime event -> UI state projection.
- Create: `vscode-extension/views/runs-tree-provider.mjs` — Activity Bar run/phase/agent hierarchy.
- Create: `vscode-extension/views/console-panel.mjs` — Webview panel with timeline/detail tabs.
- Create: `vscode-extension/adapters/vscode-ui-sink.mjs` — `UiSinkPort` implementation.
- Create: `vscode-extension/adapters/vscode-log-port.mjs` — `LogPort` implementation.
- Create: `vscode-extension/adapters/vscode-cancellation-port.mjs` — `CancellationPort` implementation.
- Create: `extensions/ghcp-maestro/runtime/ports.mjs` — interface contracts and JSDoc typedefs.
- Create: `extensions/ghcp-maestro/runtime/maestro-router.mjs` — shared `/maestro` subcommand parsing/dispatch.
- Modify: `extensions/ghcp-maestro/extension.mjs` — consume shared router without behavior drift.
- Create: `tests/maestro-router.test.mjs` — parser/dispatch parity tests.
- Create: `tests/run-view-model.test.mjs` — UI projection reducer tests.
- Modify: `README.md` — dual-install guidance (GHCP plugin + VS Code extension).

### Task 1: Define core ports and shared `/maestro` router

**Files:**
- Create: `extensions/ghcp-maestro/runtime/ports.mjs`
- Create: `extensions/ghcp-maestro/runtime/maestro-router.mjs`
- Modify: `extensions/ghcp-maestro/extension.mjs`
- Test: `tests/maestro-router.test.mjs`

**Interfaces:**
- Consumes: Existing workflow runners (`runTaskWorkflow`, `runBrainstormWorkflow`, `runHelloWorkflow`, `runSavedWorkflowCommand`, `listSavedWorkflows`).
- Produces:
  - `createMaestroRouter({ subcommands, onHelp, onWarn, onError }): MaestroRouter`
  - `router.dispatch(input: string): Promise<void>`
  - JSDoc contracts: `RuntimePort`, `UiSinkPort`, `LogPort`, `CancellationPort`

- [ ] **Step 1: Write the failing router tests**

```js
// tests/maestro-router.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createMaestroRouter } from "../extensions/ghcp-maestro/runtime/maestro-router.mjs";

test("dispatches known subcommand with tail args", async () => {
  let called = null;
  const router = createMaestroRouter({
    subcommands: [{ name: "task", needsArg: "task description", run: async (arg) => (called = arg) }],
    onHelp: async () => {},
    onWarn: async () => {},
    onError: async () => {},
  });
  await router.dispatch("task investigate timeout");
  assert.equal(called, "investigate timeout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/maestro-router.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `maestro-router.mjs`.

- [ ] **Step 3: Implement ports and router minimally**

```js
// extensions/ghcp-maestro/runtime/ports.mjs
/**
 * @typedef {{ runCommand: (input: {subcommand:string,args:string}) => Promise<unknown>, resumeRun: (runId:string)=>Promise<void>, stopRun: (runId:string)=>Promise<void> }} RuntimePort
 * @typedef {{ onRunEvent: (event: {type:string, runId:string, phase?:string, agentId?:string, payload?:unknown}) => void }} UiSinkPort
 * @typedef {{ info: (msg:string)=>Promise<void>|void, warn: (msg:string)=>Promise<void>|void, error: (msg:string)=>Promise<void>|void }} LogPort
 * @typedef {{ isCancelled: ()=>boolean, onCancel: (cb:()=>void)=>void }} CancellationPort
 */
export {};

// extensions/ghcp-maestro/runtime/maestro-router.mjs
export function createMaestroRouter({ subcommands, onHelp, onWarn, onError }) {
  return {
    async dispatch(input) {
      const arg = (input ?? "").trim();
      if (!arg || arg === "help" || arg === "--help" || arg === "-h") return onHelp();
      const spaceIdx = arg.indexOf(" ");
      const head = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
      const tail = spaceIdx === -1 ? "" : arg.slice(spaceIdx + 1).trim();
      const sc = subcommands.find((c) => c.name === head);
      if (!sc) return onWarn(`unknown subcommand '${head}'`);
      if (sc.needsArg && !tail) return onWarn(`/${sc.name} requires ${sc.needsArg}`);
      try {
        await sc.run(tail);
      } catch (err) {
        await onError(`${sc.name} failed: ${err?.message ?? err}`);
      }
    },
  };
}
```

- [ ] **Step 4: Wire GHCP extension to router and keep behavior**

```js
// extensions/ghcp-maestro/extension.mjs (inside command handler)
import { createMaestroRouter } from "./runtime/maestro-router.mjs";

const router = createMaestroRouter({
  subcommands: MAESTRO_SUBCOMMANDS,
  onHelp: maestroHelp,
  onWarn: (msg) => session.log(`ghcp-maestro: ${msg}`, { level: "warning" }),
  onError: (msg) => session.log(`ghcp-maestro: ${msg}`, { level: "error" }),
});

await router.dispatch(ctx?.args ?? "");
```

- [ ] **Step 5: Run tests and ensure pass**

Run: `node --test tests/maestro-router.test.mjs`  
Expected: PASS (`1..N`, no failures).

- [ ] **Step 6: Commit**

```bash
git add extensions/ghcp-maestro/runtime/ports.mjs extensions/ghcp-maestro/runtime/maestro-router.mjs extensions/ghcp-maestro/extension.mjs tests/maestro-router.test.mjs
git commit -m "refactor: extract shared maestro router and runtime ports"
```

### Task 2: Scaffold VS Code extension package and chat entrypoint

**Files:**
- Create: `vscode-extension/package.json`
- Create: `vscode-extension/extension.mjs`
- Create: `vscode-extension/chat/participant.mjs`
- Test: `tests/vscode-participant-contract.test.mjs`

**Interfaces:**
- Consumes: `createMaestroRouter(...)` from Task 1.
- Produces:
  - `activate(context)` in `vscode-extension/extension.mjs`
  - `createMaestroParticipant({ runtimePort, logPort, uiSink }): { handleRequest }`

- [ ] **Step 1: Write failing participant contract test**

```js
// tests/vscode-participant-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createMaestroParticipant } from "../vscode-extension/chat/participant.mjs";

test("participant delegates command text to runtime port", async () => {
  let got = null;
  const participant = createMaestroParticipant({
    runtimePort: { runCommand: async (input) => (got = input), resumeRun: async () => {}, stopRun: async () => {} },
    logPort: { info() {}, warn() {}, error() {} },
    uiSink: { onRunEvent() {} },
  });
  await participant.handleRequest("/maestro task demo");
  assert.equal(got.subcommand, "task");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/vscode-participant-contract.test.mjs`  
Expected: FAIL with missing module under `vscode-extension/chat/participant.mjs`.

- [ ] **Step 3: Add minimal VS Code extension manifest and activation**

```json
{
  "name": "ghcp-maestro-vscode",
  "displayName": "ghcp-maestro",
  "version": "0.1.0",
  "engines": { "vscode": "^1.102.0" },
  "main": "./extension.mjs",
  "activationEvents": ["onChatParticipant:ghcp-maestro.workflow", "onView:maestroRuns"],
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "maestro", "title": "Maestro", "icon": "media/maestro.svg" }] },
    "views": { "maestro": [{ "id": "maestroRuns", "name": "Runs" }] },
    "chatParticipants": [{ "id": "ghcp-maestro.workflow", "name": "maestro", "fullName": "ghcp-maestro" }]
  }
}
```

- [ ] **Step 4: Implement participant with router reuse**

```js
// vscode-extension/chat/participant.mjs
import { createMaestroRouter } from "../../extensions/ghcp-maestro/runtime/maestro-router.mjs";

export function createMaestroParticipant({ runtimePort, logPort }) {
  const router = createMaestroRouter({
    subcommands: [
      { name: "task", needsArg: "task description", run: (arg) => runtimePort.runCommand({ subcommand: "task", args: arg }) },
      { name: "brainstorm", needsArg: "topic", run: (arg) => runtimePort.runCommand({ subcommand: "brainstorm", args: arg }) },
      { name: "run", needsArg: "name [args]", run: (arg) => runtimePort.runCommand({ subcommand: "run", args: arg }) },
      { name: "workflows", needsArg: false, run: () => runtimePort.runCommand({ subcommand: "workflows", args: "" }) },
    ],
    onHelp: () => logPort.info("Use /maestro <task|brainstorm|run|workflows>"),
    onWarn: (m) => logPort.warn(m),
    onError: (m) => logPort.error(m),
  });
  return {
    handleRequest: async (text) => router.dispatch((text ?? "").replace(/^\/maestro\s*/, "")),
  };
}
```

- [ ] **Step 5: Run test and verify pass**

Run: `node --test tests/vscode-participant-contract.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode-extension/package.json vscode-extension/extension.mjs vscode-extension/chat/participant.mjs tests/vscode-participant-contract.test.mjs
git commit -m "feat: scaffold vscode participant with shared maestro router"
```

### Task 3: Build run view-model and VS Code UI sink adapter

**Files:**
- Create: `vscode-extension/state/run-view-model.mjs`
- Create: `vscode-extension/adapters/vscode-ui-sink.mjs`
- Test: `tests/run-view-model.test.mjs`

**Interfaces:**
- Consumes: `UiSinkPort` event shape from Task 1.
- Produces:
  - `createRunViewModel(): { apply(event), snapshot(), subscribe(cb) }`
  - `createVsCodeUiSink({ model }): UiSinkPort`

- [ ] **Step 1: Write failing reducer test**

```js
// tests/run-view-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRunViewModel } from "../vscode-extension/state/run-view-model.mjs";

test("projects run/phase/agent hierarchy from events", () => {
  const vm = createRunViewModel();
  vm.apply({ type: "agent.started", runId: "r1", phase: "explore", agentId: "a1" });
  vm.apply({ type: "agent.finished", runId: "r1", phase: "explore", agentId: "a1", payload: { status: "ok" } });
  const snap = vm.snapshot();
  assert.equal(snap.runs[0].id, "r1");
  assert.equal(snap.runs[0].phases[0].agents[0].status, "ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/run-view-model.test.mjs`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement minimal view model + sink**

```js
// vscode-extension/state/run-view-model.mjs
export function createRunViewModel() {
  const runs = new Map();
  const listeners = new Set();
  const ensure = (runId, phase, agentId) => {
    if (!runs.has(runId)) runs.set(runId, { id: runId, phases: new Map() });
    const run = runs.get(runId);
    if (phase && !run.phases.has(phase)) run.phases.set(phase, { name: phase, agents: new Map() });
    if (phase && agentId && !run.phases.get(phase).agents.has(agentId)) {
      run.phases.get(phase).agents.set(agentId, { id: agentId, status: "queued" });
    }
  };
  const emit = () => listeners.forEach((cb) => cb());
  return {
    apply(event) {
      ensure(event.runId, event.phase, event.agentId);
      if (event.agentId) {
        const agent = runs.get(event.runId).phases.get(event.phase).agents.get(event.agentId);
        if (event.type === "agent.started") agent.status = "running";
        if (event.type === "agent.finished") agent.status = event.payload?.status ?? "unknown";
      }
      emit();
    },
    snapshot() {
      return {
        runs: [...runs.values()].map((r) => ({
          id: r.id,
          phases: [...r.phases.values()].map((p) => ({ name: p.name, agents: [...p.agents.values()] })),
        })),
      };
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// vscode-extension/adapters/vscode-ui-sink.mjs
export function createVsCodeUiSink({ model }) {
  return { onRunEvent: (event) => model.apply(event) };
}
```

- [ ] **Step 4: Run test and verify pass**

Run: `node --test tests/run-view-model.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode-extension/state/run-view-model.mjs vscode-extension/adapters/vscode-ui-sink.mjs tests/run-view-model.test.mjs
git commit -m "feat: add run view-model and vscode ui sink adapter"
```

### Task 4: Implement TUI-like TreeView and Console Webview

**Files:**
- Create: `vscode-extension/views/runs-tree-provider.mjs`
- Create: `vscode-extension/views/console-panel.mjs`
- Modify: `vscode-extension/extension.mjs`
- Test: `tests/runs-tree-provider.test.mjs`

**Interfaces:**
- Consumes: `runViewModel.snapshot()` from Task 3.
- Produces:
  - `createRunsTreeProvider({ model }): TreeDataProvider`
  - `createConsolePanel({ model, context }): { reveal(), render() }`

- [ ] **Step 1: Write failing tree provider test**

```js
// tests/runs-tree-provider.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { flattenTreeRows } from "../vscode-extension/views/runs-tree-provider.mjs";

test("flattens run snapshot into run->phase->agent rows", () => {
  const rows = flattenTreeRows({
    runs: [{ id: "r1", phases: [{ name: "explore", agents: [{ id: "a1", status: "running" }] }] }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ["run", "phase", "agent"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runs-tree-provider.test.mjs`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement flatten helper + provider + panel render**

```js
// vscode-extension/views/runs-tree-provider.mjs
export function flattenTreeRows(snapshot) {
  const out = [];
  for (const run of snapshot.runs) {
    out.push({ kind: "run", id: run.id });
    for (const phase of run.phases) {
      out.push({ kind: "phase", id: `${run.id}:${phase.name}`, runId: run.id, phase: phase.name });
      for (const agent of phase.agents) {
        out.push({ kind: "agent", id: `${run.id}:${phase.name}:${agent.id}`, runId: run.id, phase: phase.name, agentId: agent.id, status: agent.status });
      }
    }
  }
  return out;
}
```

```js
// vscode-extension/views/console-panel.mjs
export function renderConsoleHtml(snapshot, selection = {}) {
  const run = snapshot.runs.find((r) => r.id === selection.runId) ?? snapshot.runs[0];
  const phases = run ? run.phases : [];
  const selectedPhase = phases.find((p) => p.name === selection.phase) ?? phases[0];
  const agents = selectedPhase ? selectedPhase.agents : [];
  return `
  <html><body>
    <h2>${run ? run.id : "No run selected"}</h2>
    <div style="display:flex;gap:16px">
      <div style="width:35%"><h3>Phases</h3><pre>${phases.map((p) => `${p.name} ${p.agents.filter((a) => a.status === "ok").length}/${p.agents.length}`).join("\n")}</pre></div>
      <div style="width:65%"><h3>Agents</h3><pre>${agents.map((a) => `${a.id}  ${a.status}`).join("\n")}</pre></div>
    </div>
  </body></html>`;
}
```

- [ ] **Step 4: Run test and verify pass**

Run: `node --test tests/runs-tree-provider.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Smoke test extension view wiring**

Run: `npm run test`  
Expected: Existing tests + new tests all PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode-extension/views/runs-tree-provider.mjs vscode-extension/views/console-panel.mjs vscode-extension/extension.mjs tests/runs-tree-provider.test.mjs
git commit -m "feat: add vscode runs tree and tui-like console panel"
```

### Task 5: Add runtime bridge, retry interactions, and docs

**Files:**
- Create: `vscode-extension/adapters/vscode-log-port.mjs`
- Create: `vscode-extension/adapters/vscode-cancellation-port.mjs`
- Modify: `vscode-extension/extension.mjs`
- Modify: `README.md`
- Test: `tests/vscode-runtime-bridge.test.mjs`

**Interfaces:**
- Consumes: `RuntimePort`, `LogPort`, `CancellationPort` contracts from Task 1.
- Produces:
  - runtime bridge from participant actions to shared workflows
  - UI actions: retry failed agent, open logs
  - documented install matrix (GHCP plugin vs VS Code extension)

- [ ] **Step 1: Write failing runtime bridge test**

```js
// tests/vscode-runtime-bridge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeBridge } from "../vscode-extension/extension.mjs";

test("retry action reruns scoped failed agent", async () => {
  let call = null;
  const bridge = createRuntimeBridge({
    runTask: async (spec) => (call = spec),
  });
  await bridge.retryAgent({ runId: "r1", phase: "explore", agentId: "a9" });
  assert.equal(call.agentId, "a9");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/vscode-runtime-bridge.test.mjs`  
Expected: FAIL with missing `createRuntimeBridge` export.

- [ ] **Step 3: Implement bridge and adapters minimally**

```js
// vscode-extension/adapters/vscode-log-port.mjs
export function createVsCodeLogPort({ stream }) {
  return {
    info: (m) => stream.markdown(`maestro: ${m}`),
    warn: (m) => stream.markdown(`⚠️ maestro: ${m}`),
    error: (m) => stream.markdown(`❌ maestro: ${m}`),
  };
}

// vscode-extension/adapters/vscode-cancellation-port.mjs
export function createVsCodeCancellationPort(token) {
  return {
    isCancelled: () => token?.isCancellationRequested === true,
    onCancel: (cb) => token?.onCancellationRequested?.(cb),
  };
}
```

```js
// vscode-extension/extension.mjs
export function createRuntimeBridge({ runTask }) {
  return {
    retryAgent: async ({ runId, phase, agentId }) => runTask({ runId, phase, agentId, retry: true }),
  };
}
```

- [ ] **Step 4: Update README install matrix**

```md
## Install surfaces

- GHCP CLI plugin: `copilot plugin install <repo>` then `copilot --experimental`
- VS Code surface: install `ghcp-maestro-vscode` extension (`.vsix` or marketplace)

Both surfaces share runtime core, but installation/distribution channels are separate.
```

- [ ] **Step 5: Run full checks**

Run: `npm run check`  
Expected: `lint` and `node --test tests/*.test.mjs` both PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode-extension/adapters/vscode-log-port.mjs vscode-extension/adapters/vscode-cancellation-port.mjs vscode-extension/extension.mjs README.md tests/vscode-runtime-bridge.test.mjs
git commit -m "feat: add vscode runtime bridge, retry actions, and install docs"
```

## Plan self-review

### 1) Spec coverage check
- In-VS Code only UI: covered by Tasks 2, 4, 5.
- TUI-like dense monitoring: covered by Task 4 panel/tree.
- Agent drill-down + interactions: covered by Tasks 4, 5.
- Core/adaptor strict separation + interfaces: covered by Task 1 and adapter tasks.
- Shared command behavior parity: covered by Tasks 1 and 2.
- Installation clarity (separate surfaces, shared core): covered by Task 5 README update.

### 2) Placeholder scan
- No `TBD`, `TODO`, or unresolved placeholders in tasks.
- Every code-changing step includes explicit code blocks.
- Every validation step includes exact commands and expected outcome.

### 3) Type/signature consistency
- Port contracts defined once in Task 1 and reused by later tasks.
- `createMaestroRouter`, `createRunViewModel`, `createRuntimeBridge` names/signatures are consistent across task references.

