# ghcp-maestro — Specification

A multi-agent workflow runtime that runs on top of GitHub Copilot CLI. It provides, as a single plugin bundle, automatic decomposition of a one-line natural-language task by an LLM → truly parallel execution by isolated child Copilot sessions → result synthesis.

References:
- [GHCP CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [GHCP CLI extensions guide (htek.dev)](https://htek.dev/articles/github-copilot-cli-extensions-complete-guide)

---

## 1. Goals

- One task → orchestration of tens to hundreds of subagents in parallel
- **Encode plans as scripts** (stored outside the host LLM context)
- Background execution without occupying the session
- Result cache + resumability
- Save/reuse workflows (`/<name>` slash commands)
- **Embedded GHCP harness pattern** — do not create a separate external CLI

## 2. Non-goals

- UI, desktop app, IDE integration (separate package planned for M7)
- No reimplementation of GHCP CLI itself
- No direct calls to external LLMs (GHCP only)
- No new LLM gateway

---

## 3. Distribution Form (Two Surfaces)

### 3.1 Main: GHCP CLI extension

- Location: `extensions/ghcp-maestro/extension.mjs` (the plugin manifest is at the repo root default location, `plugin.json`)
- SDK: `joinSession()` from `@github/copilot-sdk/extension`
- Node.js child process + JSON-RPC over stdio
- Direct ESM `.mjs` (currently zero-deps, no build step)
- Experimental surface — requires `copilot --experimental` (EXTENSIONS feature flag)
- Hot reload is verified by rerunning `copilot plugin install <repo>` (`/extensions reload` to be checked later)

### 3.2 Auxiliary: VS Code Copilot Chat participant

- `vscode.chat.createChatParticipant('ghcp-maestro.workflow', handler)`
- **`@workflow` mention or `/maestro` slash** (VS Code surface — mention name to be decided later)
- Model calls via `vscode.lm.selectChatModels` + `sendRequest`
- Progress via `stream.progress/markdown/button` + separate TreeView/Webview
- Share the core logic, split only the adapters

### 3.3 Shared core

- Workflow runtime / concurrency limits / result cache / quality helpers
- `.mjs` modules importable from both surfaces (currently zero-deps; TypeScript adoption to be revisited after M6)
- No direct calls to external LLMs — only through adapter interfaces

---

## 4. Core Requirements

### 4.1 Slash commands

Registered through extension `joinSession({ commands })`.

- `/maestro <subcommand>` — dispatch:
  - `/maestro task <natural-language>` — LLM decomposes the spec with a meta prompt → fan-out (M4)
  - `/maestro brainstorm <topic>` — hardcoded 4 angles (tech/ux/biz/risk) → synth (for demo)
  - `/maestro hello` — fixed demo with 3 explore + 1 synth
  - `/maestro pong <prompt>` — single standalone-client spec probe
  - `/maestro echo <prompt>` — single LLM-mediated probe (host-bound, limited)
- `/maestros` — recent run list from RunStore
- `/maestro-stop <id>`, `/maestro-resume <id>` — stop / resume based on RunStore
- Saved workflows are dynamically registered in M5 (name collision policy TBD)

### 4.2 Script model

- Format: ES module (`.mjs`)
- Use global APIs injected by the runtime (scripts themselves must not directly call FS/shell)
- Global APIs (draft):
  - `spawn({ prompt, agent?, allowedTools?, model? }) → Promise<AgentResult>` — implemented through the built-in `task` tool or standalone SDK calls
  - `spawnAll(specs[]) → Promise<AgentResult[]>` — automatic concurrency limiting
  - `phase(name, fn)` — progress group
  - `args` — structured input when invoking a saved workflow
  - `log(msg)` → `session.log()`
  - Quality helpers: `adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck`

### 4.3 Subagent call adapter

SubagentAdapter interface (`{ name, invoke(spec, ctx) }`) — the runtime calls child agents only through adapters.

Adopted / discarded after measurement:

- (a) **`session.sendAndWait`** (LLM-mediated, `llmMediatedAdapter`) — depends on the host session turn lifecycle → no true fan-out, discarded (probe code only retained)
- (b) **`session.rpc.agentRegistry.spawn`** — exists only in SDK `d.ts`; runtime surface not exposed (`undefined`) → unusable
- (c) **Standalone `CopilotClient`** (`createStandaloneClientAdapter`) — adopted. Pass `process.execPath` (sea-loaded `copilot.exe`) to `RuntimeConnection.forStdio({ path })`, then per-spec `createSession`/`sendAndWait`/`disconnect`. **True isolation + true parallelism**.

Scripts directly import the adapter (`{ adapter: standalone }`) — no mode flag at the call site.

### 4.4 Concurrency / cap

- Default concurrency 16 (adjusted based on CPU/settings)
- Global cap 1000 agent/run
- Per-phase cap option

### 4.5 State / persistence

- Default location: `~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/` (override: `GHCP_MAESTRO_DATA_DIR` env)
- Files:
  - `manifest.json` — workflow, args, status (`running`/`complete`/`stopped`/`error`), startedAt / finishedAt
  - `agents/<agentId>.json` — spec + status + output/error + timestamps
  - (planned for M5) `script.mjs` — copy of the saved workflow code
- Resume: through `runHandle`, `spawnAll` automatically performs cache lookup → if present, `result.cached: true`; otherwise calls adapter → write
- atomic write (tmp → rename), partial crash recovery verified
- `infiniteSessions` integration after M7 (VS Code surface)

### 4.6 Meta prompt (script generator)

- When `/maestro task <natural-language>` is called (M4 implementation):
  1. A `plan` agent (standalone child session) analyzes the task with a meta prompt → generates a `[{agent, prompt}]` JSON array
  2. The parser validates the schema (3-6 entries, no duplicates, etc.); on failure, retry once with parser-error included
  3. spec array → `spawnAll(standaloneAdapter)` true parallelism
  4. A `synth` agent cross-checks results and produces the final answer
- Pre-approval UI (subtask list + each prompt preview) deferred to M4.x — currently the raw plan is executed as-is
- Saved workflows (M5): `extensions/ghcp-maestro/saved-workflows/<name>.mjs`

### 4.7 Progress / management

- `/maestros` slash → display agent count / tokens / time by phase in the TUI
- In-progress events tracked by subscribing to `session.on('tool.execution_complete', ...)`
- Separate TreeView (`workflowProvider`) on the VS Code surface

### 4.8 Permissions / safety

- Explicit subagent tool allowlist (at call time)
- shell / network blocked by default; explicit allow required
- Policy validation through `onPreToolUse` hook
- Infinite loop prevention: global cap + per-phase cap + `onErrorOccurred` retry limit

### 4.9 Cost / model control

- Phase-specific model override with `session.setModel()` (small for exploration, large for synthesis)
- Cumulative token tracking (`tool.execution_complete` event metadata)
- Report through `/maestro usage` slash

---

## 5. Quality Patterns (Library)

Helpers imported and used from scripts:

- `adversarialReview(findings, { reviewers })` — independent agent rebuttals → return only what survives
- `multiAngle(task, { angles })` — drafts from multiple angles → compare → adopt
- `fixLoop({ build, test, maxIters })` — repeat until clean
- `crossCheck(claims, { sources })` — verify each claim against multiple sources

Reference pattern: multi-reviewer voting / multi-angle drafting / loop-until-clean on top of `spawnAll` — the general form of multi-agent quality patterns.

---

## 6. Architecture Overview (reflecting M4 measurements)

```
┌─────────────────────────────────────────────────────────────────┐
│  GHCP CLI session  (copilot --experimental, host session)       │
│                                                                 │
│  ┌────────────────────────────────────────────────────┐         │
│  │  ghcp-maestro extension (joinSession)              │         │
│  │  • commands: /maestro task|hello|brainstorm|...    │         │
│  │              /maestros, /maestro-resume|-stop      │         │
│  │  • env probes: GHCP_MAESTRO_PROBE_*                │         │
│  │  • session.log() → host timeline                   │         │
│  └──────────────┬─────────────────────────────────────┘         │
│                 │                                               │
│                 ▼                                               │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Workflow runtime (in-process, zero-deps)          │         │
│  │  • runHelloWorkflow / runBrainstormWorkflow        │         │
│  │  • runTaskWorkflow  (M4: plan → explore → synth)   │         │
│  │  • spawn / spawnAll  (concurrency cap 16, max 1000)│         │
│  │  • RunStore  (manifest + agents/*, atomic write)   │         │
│  └──────────────┬─────────────────────────────────────┘         │
│                 │ adapter.invoke(spec)                          │
│                 ▼                                               │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Subagent adapters                                 │         │
│  │  • dummy            (in-process echo, tests)       │         │
│  │  • llm-mediated     (host turn — limited probe)    │         │
│  │  • standalone-client → CopilotClient → N children  │         │
│  └──────────────┬─────────────────────────────────────┘         │
└─────────────────┼───────────────────────────────────────────────┘
                  │ spawns
                  ▼
   ┌─────────────────────────────────────────────────────┐
   │  N isolated child Copilot CLI processes / sessions  │
   │  (one per AgentSpec, no shared history, runs in     │
   │   parallel up to DEFAULT_CONCURRENCY)               │
   └─────────────────────────────────────────────────────┘
```

VS Code β surface (chat participant + TreeView) is Phase 7.

---

## 7. Technology Stack

- Node.js 20+ / ESM
- TypeScript (development), build output is `.mjs` (CLI extension constraint)
- SDK: `@github/copilot-sdk` (extension + standalone)
- Concurrency: `p-queue` or custom implementation
- Persistence: filesystem JSON
- VS Code auxiliary surface: `vscode` API + `@vscode/chat-extension-utils`

---

## 8. Milestones by Phase (current progress)

- **M1 — PoC extension** ✅ — `extensions/ghcp-maestro/extension.mjs` skeleton, verified `/maestro hello` load
- **M2 — Spawn runtime** ✅ — zero-deps semaphore + `spawn` / `spawnAll`, dummy adapter, 14 unit tests
- **M2.5 — LLM-mediated adapter** ✅ (mismatch confirmed, probe only retained) — host session turn-bound → no fan-out
- **M2.6 — Standalone CopilotClient adapter** ✅ — verified true isolation + parallelism
- **M3 — State/Resume** ✅ — RunStore persistence, `/maestros`, `/maestro-resume`, `/maestro-stop`, measured crash recovery
- **M4 — Meta prompt** ✅ — `/maestro task <natural-language>` → plan → explore[N] → synth
- **M4.x — Plan pre-approval UI** ❌ — `session.ui.elicitation` integration (optional)
- **M5 — Saved workflows** ✅ — `runtime/saved-workflows.mjs` scan(project>user>bundled) + `/maestro run <name>` / `/maestro workflows`, sandboxed `api` (`buildWorkflowApi`), bundled `deep-review` example
- **M6 — Quality helpers** ✅ — `runtime/quality.mjs`: `adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck` (on top of `spawnAll`, adapter-independent, unit tests complete)
- **M7 — VS Code surface** ❌ — separate `vscode-extension/` package
- **M8 — Standalone SDK fan-out** ✅ (completed early in M2.6)
- **CI / static analysis** ✅ — ESLint flat config + `.github/workflows/ci.yml` (lint + `node --check` + `node:test`, Node 20/22) + `codeql.yml`

For detailed deliverables / measurements / acceptance, see [PLAN.md](PLAN.md).

---

## 9. Core Value

Integrated as one plugin on top of GHCP CLI:

- Automatic natural-language task decomposition (meta prompt)
- Isolated child Copilot session fan-out (true parallelism, concurrency cap 16 / global 1000)
- Result persistence + partial crash recovery (`~/.copilot/plugin-data/ghcp-maestro/`)
- Host session context isolation

---

## 10. Open Questions (updated as of M4)

- ✅ **Q1.** Standalone SDK integration priority — completed early in M2.6 (`standalone-client` adapter)
- **Q2.** Meta prompt model — currently uses the child session default model as-is. The forced `setModel('xhigh')` option will be reviewed in M4.x.
- **Q3.** VS Code surface priority — after M5/M6 (currently GHCP-only verification complete)
- ✅ **Q4.** Saved workflow slash — dynamic registration decided (planned for implementation in M5)
- **Q5.** TS → `.mjs` build — currently operating directly with zero-deps plain `.mjs`. If helper libraries grow in M5/M6, reconsider introducing esbuild.
- ✅ **Q6.** Memory/Resume auxiliary integration — implemented directly (M3 RunStore). No external dependency.
- **Q7. (new)** Plan pre-approval — whether to show subtask list + each prompt preview through `session.ui.elicitation` (M4.x).
- **Q8. (new)** Saved workflow security — whether to execute `.mjs` shared by others without trust verification, or require permission preview (reflecting M5 brainstorm results).
