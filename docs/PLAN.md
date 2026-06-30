# Action Plan

Break down the vision in REQUIREMENTS.md into concrete execution steps. For milestones M1~M8, see REQUIREMENTS §8.

---

## Phase 0 — Preliminary research (done)

### 0.1 GHCP plugin / extension structure analysis

Items to verify:
- [GHCP CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- `@github/copilot-sdk` npm package (`/extension` / `CopilotClient` surface)
- GHCP CLI built-in SDK bootstrap (extension subprocess spawn flow)
- Extension examples in the `awesome-copilot` repo (`feedback-themes`, etc.)

Items to extract:
- SDK APIs capable of subagent fan-out
- Real examples of plugin.json / extension manifests
- `joinSession()` call boilerplate

### 0.2 GHCP CLI extension SDK measurement

Verify theory vs. actual behavior:
- Export surface of `@github/copilot-sdk` (`/extension`, `CopilotClient`)
- Actual options for `joinSession({ commands, tools, hooks, customAgents, infiniteSessions })`
- Availability of `session.send` / `sendAndWait` / `on` / `ui.elicitation` / `setModel`
- Built-in `task` tool call signature (subagent dispatch)
- Current status of known bugs (hook overwrite, etc.)

Verification method: create an empty extension, print `session.capabilities`, and call each API with try-catch

### 0.3 First-pass answers to open questions

- Q1 Standalone SDK integration timing: M8 → in practice, adopted earlier in M2.6 (`standalone-client` adapter)
- Q2 Meta-prompt model: current child session default model
- Q3 VS Code surface: proceed with M7 after GHCP extension validation (M4)
- Q4 Saved workflow slash commands: dynamic registration — M5
- Q5 Build: currently running zero-deps `.mjs` directly; revisit after M6
- Q6 Memory/Resume support: implement RunStore directly without external dependencies (M3)

→ Reconfirm at M4 — see `docs/REQUIREMENTS.md` §10.

---

## Phase 1 — M1 PoC

### 1.1 Directory skeleton (actually adopted)

```
ghcp-maestro/                     # repo == plugin root
├── plugin.json                   # GHCP plugin manifest (root, docs default)
├── extensions/
│   └── ghcp-maestro/             # SDK extension component (joinSession)
│       ├── extension.mjs         # entry point
│       └── package.json          # type:module, main:extension.mjs
├── docs/
│   ├── REQUIREMENTS.md
│   └── PLAN.md
├── AGENTS.md
├── README.md
└── LICENSE
```

> Actually adopted: did not create a `src/` directory; integrated everything under `extensions/ghcp-maestro/runtime/` (concurrency, spawn, run-store, adapters/). As a result of M2~M4, running zero-deps `.mjs` directly is sufficiently clean — revisit esbuild adoption if helper libraries grow in M6.

### 1.2 M1 acceptance criteria

- [x] ghcp-maestro extension loads when starting a `copilot --experimental` session (log `Extension ready: …extension.mjs`)
- [x] `/maestro hello` slash registered (confirmed in CLI command registry — TUI invocation is in the user validation area)
- [x] Handler executes one hardcoded script (2 phases, 4 dummy agents)
- [ ] Each agent calls the built-in `task` tool → collect results *(deferred to M2 — currently inline dummy spawn)*
- [x] Print completion log + result summary via `session.log`
- [ ] Hot reload works via `/extensions reload` *(only manual reinstall verified; experimental surface — confirm later)*
- [x] `package.json` `type: "module"`, ESM only

### 1.3 Non-functional requirements

- Minimize dependencies (runtime targets zero deps)
- Use only `session.log` (no direct stdout output — breaks JSON-RPC)
- Tool name prefix: `ghcp_maestro_*` (collision prevention)

---

## Phase 2 — M2 Concurrency / Spawn adapter (done)

### Deliverables
- `extensions/ghcp-maestro/runtime/concurrency.mjs` — zero-deps semaphore + `runWithConcurrency`
- `extensions/ghcp-maestro/runtime/spawn.mjs` — `spawn`, `spawnAll`, `SubagentAdapter` interface, `dummyAdapter`, `GLOBAL_AGENT_CAP=1000`, `DEFAULT_CONCURRENCY=16`
- `tests/concurrency.test.mjs` + `tests/spawn.test.mjs` — 14 tests passed (`node --test`)
- `extension.mjs` — `/maestro hello` uses the new runtime `spawnAll(dummyAdapter)`

### M2 acceptance criteria
- [x] Implement `spawnAll(specs[], { concurrency })` + preserve input order
- [x] Custom p-queue-like implementation (zero-deps semaphore)
- [x] Enforce global cap 1000 + RangeError
- [x] Adapter interface finalized (dummy implementation; LLM-mediated / agentRegistry.spawn are M2.5+M8)
- [x] Unit tests: concurrency cap / ordering / error propagation / timeout / pre-aborted signal

### Adapter candidates (after M2.5)
- **LLM-mediated**: `session.sendAndWait("/agent ... ")` — LLM calls the built-in task tool; capture result events. Cost ↑ speed ↓ accuracy ↑
- **agentRegistry.spawn (heavy)**: `session.rpc.agentRegistry.spawn({ cwd, agentName, model, initialPrompt })` — fork a new managed-server child. True parallelism, highest cost
- SDK has **no direct task tool call surface** that bypasses the LLM (confirmed)

---

## Phase 2.5 — LLM-mediated adapter prototype (done, mismatch confirmed)

Created `extensions/ghcp-maestro/runtime/adapters/llm-mediated.mjs` and measured via env probe.
**Conclusion**: (A) depends on the user session's turn lifecycle — true fan-out is impossible. Discarded.

---

## Phase 2.6 — Standalone CopilotClient adapter (done, real fan-out verified)

### Deliverables
- `extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs` — `new CopilotClient(RuntimeConnection.forStdio({ path: process.execPath }))` + per-spec `createSession` → `sendAndWait` → `disconnect`. Lazy boot + reuse.
- `extension.mjs` — `/maestro hello` swapped to standalone adapter. `/maestro pong <prompt>` single-spec probe. `GHCP_MAESTRO_PROBE_PONG`, `GHCP_MAESTRO_PROBE_HELLO` ENV trigger.
- Key trick: the extension's `process.execPath` is the sea-loaded `copilot.exe`. The SDK's `spawn(cliPath, args)` calls it directly when it is not `.js`, so passing execPath as cliPath works. Passing `index.js` as cliPath causes commander to emit an "Invalid command format" error.

### Measured results (2026-06-29 13:31, 3-spec fan-out)
```
phase=explore agents=3 (parallel)
explore/explore-a status=ok took=6481ms reply="ALPHA"
explore/explore-b status=ok took=6715ms reply="BRAVO"
explore/explore-c status=ok took=6391ms reply="CHARLIE"
phase=explore wall-clock=6805ms (parallel of 3)         ← true parallelism
phase=synth agents=1
synth status=ok took=2655ms reply="ALPHA BRAVO CHARLIE" ← pass results to next phase
hello workflow complete (4 agents across 2 phases)
```

### M2.6 acceptance criteria
- [x] standalone client adapter (satisfies SubagentAdapter)
- [x] Create real isolated child Copilot sessions + collect results
- [x] Run N specs concurrently (3-spec wall-clock ≈ one slowest spec)
- [x] Next phase uses previous phase results
- [x] Host session context isolation (host tokens = user prompt only)

### Behavior verification dimensions
| Dimension | Status |
|---|---|
| spec → child agent | ✅ |
| true parallelism (concurrency cap 16) | ✅ |
| results → next phase | ✅ |
| host context isolation | ✅ |

---

## Phase 3 — M3 State / Resume (done)

### Deliverables
- `extensions/ghcp-maestro/runtime/run-store.mjs` — RunStore persistence layer:
  - `createRun({workflow, args})` / `openRun(runId)` / `listRuns()`
  - `runHandle.writeAgent / readAgent / listAgents / patchManifest / complete`
  - atomic write (tmp → rename) — crash-safe
  - default path: `~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/`
- `runtime/spawn.mjs` — `spawnAll(..., { runHandle })`: automatic cache lookup/write, marks `result.cached: true`
- `extension.mjs` — workflow registry (`hello`, `brainstorm`), `/maestros`/`/maestro-resume <id>`/`/maestro-stop <id>` slashes
- `tests/run-store.test.mjs` — 6 cases (manifest, agent round-trip, atomic, cache hit/miss, complete)

### Measured results (2026-06-29 13:40)
**Step 1 — initial hello run (real LLM)**:
```
phase=explore wall-clock=7987ms (parallel of 3)
synth status=ok took=3066ms
```
**Step 2 — resume with the same runId (full cache hit)**:
```
explore/explore-a status=ok (cached) took=7904ms
phase=explore wall-clock=2ms (parallel of 3)        ← 7987ms → 2ms
synth status=ok (cached) wall=1ms                   ← 3066ms → 1ms
```
**Step 3 — resume after deleting only the explore-b file (partial recovery)**:
```
explore-a (cached) | explore-b ok 6684ms | explore-c (cached)
phase=explore wall-clock=6687ms (parallel of 3)     ← only the deleted item is called again
```

### M3 acceptance criteria
- [x] `${BASEDIR}/runs/<runId>/` schema (manifest + agents/)
- [x] atomic write (tmp → rename)
- [x] `/maestros` list
- [x] `/maestro-resume <id>` — skip cached results, rerun only incomplete items
- [x] `/maestro-stop <id>` — marks manifest status=stopped
- [x] crash recovery scenario (resume after partial deletion)
- [x] Unit tests (6 cases, 20 total passed)

---

## Phase 4 — M4 Meta-prompt (done)

### Deliverables
- `runTaskWorkflow(session, task)` in `extension.mjs` — 3-phase automatic dynamic decomposition:
  1. **plan** (1 agent): meta-prompt + JSON schema validation; on parse failure, retry once with parser-error included
  2. **explore** (N agent, N∈[3,6]): plan result spec array → `spawnAll(standaloneAdapter)` true parallelism
  3. **synth** (1 agent): cross-check all explore results, then final answer + next actions
- `parseAndValidatePlan(text)` — fence strip, array bracket fallback, length 3-6, duplicate agent check
- `/maestro task <natural language>` slash + `GHCP_MAESTRO_PROBE_TASK` env trigger
- Register `WORKFLOWS.task` → automatic integration with M3 RunStore / resume

### Measured results (2026-06-29 14:30)
**Task**: "Evaluate whether ghcp-maestro should add a Web UI to monitor running workflows in real time"

```
phase=plan agents=1   took=25189ms chars=3219
plan produced 5 subtask(s): user-value-analysis, technical-feasibility,
                            alternatives-comparison, maintenance-cost, strategic-fit

phase=explore agents=5 (parallel)
  user-value-analysis    19229ms 920ch
  technical-feasibility  14856ms 1704ch
  alternatives-comparison 62942ms 3478ch
  maintenance-cost       35410ms 1392ch
  strategic-fit          24409ms 636ch
phase=explore wall-clock=62944ms (parallel of 5)   ← sum 156s → actual 63s

phase=synth agents=1   took=16144ms
FINAL ANSWER: Defer — violates REQUIREMENTS §2, M4 incomplete, excessive for a single developer …
  + 5 Next Actions (prioritize M4 / progress callbacks / TUI sidecar / M7 Webview)
task workflow complete — 7 agents across 3 phases
```

### M4 acceptance criteria
- [x] One-line natural-language task input
- [x] LLM automatically decomposes into 3-6 independent subtasks (JSON array)
- [x] schema validation + one retry (including parser-error feedback)
- [x] true parallel subtasks (wall-clock = max(subtasks), not sum)
- [x] synth cross-checks all results, then final answer
- [x] RunStore persistence + automatic resume integration (all 3 phases cacheable)

### M4 behavior summary
| Dimension | Status |
|---|---|
| Decomposition owner (LLM `plan` agent) | ✅ |
| true parallelism | ✅ (measured wall-clock 63s ≈ max(subtask)) |
| context isolation | ✅ (5 isolated child sessions) |
| results → next phase | ✅ |
| Resume + cache | ✅ |
| Plan pre-approval UI | ✅ M4.x (Phase 6.x) |
| Script code export | ❌ M5 (currently only plan JSON is persisted) |

---

## Phase 5 — M5 Save / Rerun (done)

### Deliverables
- `extensions/ghcp-maestro/runtime/saved-workflows.mjs`:
  - `defaultWorkflowDirs` (project `./.ghcp-maestro/workflows` or `$GHCP_MAESTRO_WORKFLOWS_DIR` > user `<dataDir>/workflows` > bundled `saved-workflows/`)
  - `scanSavedWorkflows` — kebab-case + reserved-name validation, priority dedupe, skip reason collection
  - `loadSavedWorkflow` — dynamic import + default/`run` export validation
  - `buildWorkflowApi` — sandboxed `api` (bound `spawn`/`spawnAll`/`phase`/`log`/`args` + M6 helper). Scripts do not call FS/shell/SDK directly.
  - `parseWorkflowArgs` — JSON object or plain text (=>`{input}`)
- `extension.mjs` — scan at boot → `/maestro run <name> [args]` / `/maestro workflows`, `saved:<name>` run persistence + resume resolver
- `saved-workflows/deep-review.mjs` — bundled example (multiAngle → adversarialReview)
- `tests/saved-workflows.test.mjs` — 11 cases

### M5 acceptance criteria
- [x] Scan `saved-workflows/<name>.mjs` directory
- [x] Dynamic slash (`/maestro run <name>`) + `args` global inject
- [x] On name conflict, project > personal (> bundled) priority
- [x] RunStore integration (`/maestros`, `/maestro-resume` work)
- (optional) M4.x — `session.ui.elicitation` plan pre-approval UI implemented in Phase 6.x

---

## Phase 6 — M6 Quality helpers (done)

### Deliverables
- `extensions/ghcp-maestro/runtime/quality.mjs` (above `spawnAll`, adapter-independent):
  - `adversarialReview(findings, { reviewers, threshold })`
  - `multiAngle(task, { angles })`
  - `fixLoop({ check, applyFix, maxIters })`
  - `crossCheck(claims, { sources })`
- `tests/quality.test.mjs` — 15 cases (deterministic validation with scripted adapter)

Each helper supports injecting prompt builder / verdict parser → unit tests without live models.

---

## Phase 6.x — M4.x Plan pre-approval gate (done)

### Deliverables
- `extensions/ghcp-maestro/runtime/plan-approval.mjs` — `planApprovalGate({ specs, ui, capabilities, autoApprove, log })` → `{ approved, selected, reason }`. Pure and adapter-free so it unit-tests with a fake `ui`.
- `extension.mjs` — gate wired into `runTaskWorkflow` between plan validation and the explore fan-out. On rejection the run is marked `stopped` (a user choice, not an error) and fan-out is skipped; on a subset the specs are narrowed and logged.
- `tests/plan-approval.test.mjs` — 11 cases.

### M4.x acceptance criteria
- [x] After the `plan` agent decomposes the task, show the subtask list + prompt previews before fan-out
- [x] Interactive only when `session.capabilities.ui.elicitation === true`; multi-select elicitation dialog (all subtasks selected by default)
- [x] accept → run the selected subset (empty selection aborts); decline/cancel → reject; a dialog that throws fails closed
- [x] Non-interactive hosts, resume replays, and `GHCP_MAESTRO_AUTO_APPROVE=1` approve everything so env probes / CI / `-p` mode keep working
- [x] Unit tests (11 cases, deterministic with a fake `ui`)

---

## Phase 7 — M7 VS Code secondary surface

- New directory `vscode-extension/` (separate package)
- `vscode.chat.createChatParticipant('ghcp-maestro.workflow', handler)`
- `vscode.lm.selectChatModels` + `sendRequest`
- Shared import of core (`extensions/ghcp-maestro/runtime/`)
- Progress TreeView `workflowsView`

---

## Phase 8 — M8 Standalone SDK fork (completed early in M2.6)

The core of this Phase — `CopilotClient` + new N session fan-out — has already been implemented/measured with the M2.6 `standalone-client` adapter.
Remaining work is to document cost/speed guidance and expose advanced options such as BYOK provider/model routing if needed.

---

## Verification / Release checklist

At the end of each Phase:
- [ ] Unit tests pass
- [ ] One manual scenario (simple task) works end-to-end
- [ ] Confirm registered surface via `/extensions info ghcp-maestro`
- [ ] Update README usage examples
- [ ] Add CHANGELOG entry
- [ ] Document known limitations / gaps

Release (after M5):
- [ ] Create `.github/plugin/marketplace.json`
- [ ] Test `copilot plugin install ...` flow
- [ ] License / security review
- [ ] One demo script (similar to `/deep-research`)

---

## Next immediate actions

Phase 5 / M5 + Phase 6 / M6 + Phase 6.x / M4.x + CI complete. Next:

1. **M7** VS Code surface — separate `vscode-extension/` package, chat participant + TreeView
2. **Real-time in-TUI run monitoring** — surface live fan-out progress in the host TUI (tracked as a separate issue; spec in `docs/specs/`)
3. **Release preparation** — `marketplace.json`, verify `copilot plugin install` flow, demo guide, security review
