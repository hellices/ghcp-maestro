# Changelog

All notable changes to **ghcp-maestro** are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
SemVer. Unreleased work is committed under `Unreleased` until a tag is pushed.

## [Unreleased]

### Added
- **`maestro-top` — standalone live TUI run monitor (opt-in).** New
  `extensions/ghcp-maestro/bin/maestro-top.mjs` viewer runs in its own
  terminal, follows the newest active run (or a given runId, or `--all`
  overview), and repaints per-agent state, elapsed, bytes, tool and tokens
  once per second. Per-agent event logs are recorded as ndjson under the run's
  `logs/` dir (`run.appendAgentEvent`, teed from the phase monitor) and can be
  expanded/collapsed per agent (`↑`/`↓`/`j`/`k`, `→`/`enter`, `←`, `a`).
  Pressing `s` drops a stop request into the run's `control/` directory; the
  runtime polls it during each phase and aborts just that agent
  (`ensureAgentController`/`abortAgent` in `core/run-registry.mjs`, per-spec
  `getAgentSignal` composition in `spawnAll`) while the rest of the fan-out
  keeps running. `GHCP_MAESTRO_TUI=1` makes the background-run hint print the
  exact viewer command. View logic is pure and unit-tested (`core/tui.mjs`,
  `core/tui-data.mjs`, `core/tui-control.mjs`). (#46)
- **`/maestro compose <description>` — generate a saved workflow from a
  natural-language description.** New `core/workflow-compose.mjs`: a planner
  agent receives the sandboxed workflow-api reference plus the description
  and writes the module; the result is parse-checked and scanned for any
  escape from the injected `api` (imports, `process`, `fetch`, `eval`, …),
  shown for review via the elicitation gate, dry-run against a token-free
  echo adapter only after approval, and saved to the project workflows
  directory ready for `/maestro run <name>`. `--name <kebab>` picks the
  name, `--force` overwrites. Non-interactive hosts save nothing runnable —
  the script lands as a `.mjs.draft` file for manual review, and a failed
  dry-run likewise keeps only a draft. `validateWorkflowCode` is now
  exported from `core/workflow-install.mjs` and shared by both paths. (#16)
- **Mid-run phase gate (opt-in).** `GHCP_MAESTRO_PHASE_GATE=1` pauses the
  task workflow a second time after the fan-out completes — before the next
  spend (write-mode integration / verify / synth) — showing a per-agent
  digest (status + output preview) and asking whether to continue. Declining
  stops the run resumably: cached agent outputs replay on `/maestro-resume`,
  which auto-approves both gates. In write mode the gate sits before any
  branch is merged, so a stop leaves the repository untouched. New
  `phaseApprovalGate` in `core/plan-approval.mjs`, same fail-closed safety
  envelope as the pre-fan-out gate. (#15)
- **`fixLoop` explicit convergence criteria.** `core/quality.mjs`: `fixLoop`
  now accepts an `until(iteration, check) -> { done, evidence }` predicate —
  an externally checkable stop condition that overrides the check's own `ok`
  flag — and `stallRounds` (stop after N consecutive rounds whose check
  report is byte-identical; `0` disables, the default). Every result carries
  `stopReason` (`converged` / `stalled` / `max-iters`) and the last observed
  `evidence` string, so saved workflows can cite *why* the loop stopped.
  Backward compatible: without `until` the loop behaves as before. (#18)
- **Opt-in write mode — worktree-per-agent isolation (`--write`).** New
  `core/write-mode.mjs`: `/maestro task --write …` requires the plan to
  declare disjoint per-subtask file scopes (overlaps rejected, planner
  retries), gives each agent its own `git worktree` on a fresh
  `maestro/<runId>/<agent>` branch with a prompt pinned to it, then merges
  branches back sequentially — running `GHCP_MAESTRO_CHECK_CMD` after each
  merge when set — and stops with an actionable report on the first conflict
  or check failure. Requires a clean work tree (`--allow-dirty` to override)
  on a checked-out branch, verified before any token is spent; worktrees with
  uncommitted work are never removed. Read-only remains the default. (#40)
- **`@file` references in `/maestro task` and `/maestro brainstorm`.** New
  `core/task-inputs.mjs`: `@<path>` tokens in the task line are resolved
  against the cwd **before the run exists** (a bad path costs zero tokens),
  and the file content is inlined — fenced, with the filename — into the plan
  prompt and every explore prompt, so isolated child sessions see the full
  spec without rediscovering it. Caps: 4 files, 16k chars/file (truncated
  with a marker), 48k combined. The manifest keeps the raw line, so resume
  re-reads the same files. Lines without `@refs` produce byte-identical
  prompts to before. (#39)

## [0.7.0] - 2026-07-29

### Added
- **Demo GIF + scripted replay.** New `demo/replay.mjs` (a presentation-only
  replay of a `/maestro task` run that closely mirrors the runtime's real log
  output) and `demo/demo.tape` (VHS scene) render `docs/assets/demo.gif`,
  now embedded at the top of both READMEs. Dev-only: `demo/` and
  `docs/assets/` are excluded from release archives.
- **Always-on token accounting.** Completed task runs log their total token
  usage (`tokens=<used>[/limit]`) and persist `tokensUsed` in the run
  manifest (budget-stopped runs too); `/maestros` shows `tokens=<n>` per run.
  Enforcement stays opt-in via `GHCP_MAESTRO_BUDGET_TOKENS` — accounting
  always-on, spend caps only when explicitly configured.
- **Cross-agent prompt-injection hardening.** Dependency outputs
  (`augmentPromptWithDeps`) and the synth digest (`buildSynthPrompt`) are now
  fenced in `<<<UNTRUSTED-AGENT-OUTPUT>>>` sentinels with an explicit
  treat-as-data instruction, per OWASP Agentic Security guidance — agent
  output is data, not instructions. Always-on, zero token cost. (#33)
- **Opt-in per-label model routing.** New `core/model-routes.mjs`:
  `GHCP_MAESTRO_MODEL_ROUTES` (or `opts.modelRoutes`) maps label patterns
  (`plan`, `explore:<agent>`, `verify`, `synth`; `*` wildcards,
  first-match-wins) to models so fan-out workers can run on cheaper models
  than the planner/synth. No routes → adapter default, specs unchanged. (#17)
- **Opt-in verify phase.** `GHCP_MAESTRO_VERIFY=1` (or `opts.verify`) inserts
  a verification agent between explore and synth that judges each subtask
  output against the *original task objective* (met / partially-met /
  not-met + gaps, MAST-style); the report feeds the synth prompt. Verify
  failure is non-fatal. Off by default — one extra agent per run. (#31)
- **OTel GenAI-style trace export.** New `core/trace.mjs` + `writeRunTrace`
  in `run-flow.mjs`: every terminal run (complete / stopped / error) writes
  `trace.json` — an `invoke_workflow` root span plus `invoke_agent` child
  spans with `gen_ai.*` semantic-convention attributes. Always-on, zero deps,
  best-effort (never fails a run). (#32)
- **Release polish.** New `docs/DEMO.md` — a five-minute end-to-end
  `/maestro task` walkthrough with real log-line formats (install → plan gate
  → parallel explore + `/maestros` dashboard → synth → resume/stop). READMEs
  gain a **Known limitations** section, the `copilot plugin install` flow was
  verified end-to-end against the self-served marketplace (0.5.0 → 0.6.0
  upgrade), and the release-archive file list was re-confirmed lean after the
  docs reorg. (#24)
- **`/maestro install <source> [--force]` — one-command workflow install.**
  New `core/workflow-install.mjs`: accepts a github.com blob URL, a
  raw.githubusercontent.com URL, or `owner/repo/path/flow.mjs[@ref]` shorthand
  (ref defaults to `main`; https only), downloads the file (256 KB cap, checked
  against Content-Length before the body is read; redirects refused so a raw
  URL cannot bounce off GitHub), and validates it **without executing it** —
  `node --check` parse + default/`run` export scan on a quarantined temp copy —
  before writing to the *user* workflow dir; project workflows still shadow
  it. Existing names are never overwritten without `--force`, installs confirm
  via elicitation when the host supports it (dialog errors fail closed), and
  every install prints a review-before-running warning. `install` joins the
  reserved workflow names. (#23)
- **Agent auto-retry with exponential backoff.** `spawn`/`spawnAll` retry
  `error`-status attempts (API blips, rate limits) with exponential backoff +
  jitter — `GHCP_MAESTRO_RETRIES` extra attempts (default 1, `0` disables).
  `timeout`/`aborted` outcomes never retry, backoff sleeps abort with the run
  signal, and results/persisted agent records carry an `attempts` count. The
  quality helpers forward `retries`/`retryBaseMs`. (#20)
- **Cost visibility + token budget cap.** New `core/budget.mjs`: the task
  workflow logs a run-size estimate at the plan gate (also shown in the
  approval dialog), warns on fan-outs of `GHCP_MAESTRO_LARGE_RUN_AGENTS`+
  subtasks (default 5), and `GHCP_MAESTRO_BUDGET_TOKENS` (accepts `500k`/`2m`)
  soft-stops a run once exceeded — in-flight agents finish, un-started agents
  are skipped as `aborted`, the run is marked `stopped` and stays resumable
  via `/maestro-resume`. `spawn`/`spawnAll`/`runPhase` accept a shared
  `budget` tracker. (#14)
- **DAG plans: `dependsOn` between subtasks.** The plan schema gains an
  optional `dependsOn: string[]` (validated: known agents, no self-reference,
  no cycles). `planLayers` groups specs into topological layers; the task
  workflow fans each layer out in order and injects dependency outputs
  (truncated to 4 000 chars each) into dependents' prompts via
  `augmentPromptWithDeps`. Dependents of a failed dependency are persisted as
  a new `skipped` status without invoking the adapter, so `/maestro-resume`
  reruns them. Plans without `dependsOn` behave exactly as before. (#21)
- **Partial-failure disclosure in synthesis.** `agentDigest` renders non-`ok`
  results as `## <agent> (FAILED: <status>)` blocks with the error text;
  `buildSynthPrompt` adds a "state explicitly which angles are missing"
  instruction when any subagent failed (all-ok prompts are byte-identical to
  before); the task workflow logs a `coverage: N/M subtasks ok (…)` line next
  to the final answer. Both surfaces share the change via `core/synth.mjs`. (#22)

### Fixed
- **Resume now reruns failed agents.** `spawn` replays only cached `ok` records
  from the run store; cached `error`/`timeout`/`aborted` records re-invoke the
  adapter on `/maestro-resume`, matching the documented resume contract
  (previously a failed agent's cached failure was replayed forever).
- **In-flight cancellation actually interrupts agents.** The standalone-client
  adapter races `sendAndWait` against the caller's `AbortSignal` (`raceAbort`),
  so timeouts and user cancellation no longer wait for the model to finish.

### Changed
- **READMEs slimmed, docs split.** The long "Features" section and the
  configuration table moved to `docs/GUIDE.md` / `docs/GUIDE.ko.md`; the
  CLI-vs-VS-Code install-surface details moved to `docs/SURFACES.md`. The
  READMEs keep a compact feature summary, the commands table, and links.
- **Design docs consolidated under `docs/specs/`.** The `docs/superpowers/`
  tree (specs + implementation plans) is gone; all design/plan documents now
  live in `docs/specs/` and the stale `export-ignore` rule was dropped.
- **`/maestro-stop` aborts in-flight agents.** New `core/run-registry.mjs`
  (process-local runId → `AbortController`); `runPhase` wires the registry
  signal by default and `stopRun` aborts it, so stopping a run started in the
  same session interrupts its agents instead of only flipping the manifest.
- **`/maestro workflows` rescans the workflow dirs** (and `/maestro run`
  rescans on a name miss), so workflows added after startup are picked up
  without restarting the CLI.
- **VS Code runtime bridge deduplicated against core**: uses
  `runWithConcurrency` and `DEFAULT_CONCURRENCY` from core instead of local
  copies; the `<name> [args]` split is shared as
  `splitWorkflowInvocation` in `core/saved-workflows.mjs`.

## [0.6.0] - 2026-07-03

Adds a VS Code surface alongside the CLI plugin and extracts the runtime into a
shared, zero-deps `core/` package consumed by both. The CLI behaviour is
unchanged; the plugin now imports the same core the VS Code extension uses.

### Added
- **VS Code `/maestro` chat participant** with a TUI-like Run Console (webview)
  and an Activity Bar Runs tree for per-agent drill-down (model, tokens, tools,
  timing, prompt/output/error, retry). Ships as a separate VS Code extension
  (`vscode-extension/`), not part of the CLI plugin archive.
- **Shared `core/` package** (`@ghcp-maestro/core`): the fan-out, spawn,
  run-store, saved-workflows, quality, plan/approval, probes, and synth logic —
  surface-neutral and unit-tested — now imported by both the CLI plugin
  (`extensions/ghcp-maestro/`) and the VS Code extension.

### Changed
- **Unified synth + run commands.** `core/synth.mjs` (`buildSynthPrompt`) is the
  single source for the synthesis prompt across both surfaces; `showRuns` /
  `resumeRun` / `stopRun` moved into `core/run-commands.mjs`. The CLI reproduces
  its prior synth prompt and run-listing output byte-for-byte.
- **Slimmed the CLI extension God-file** (`extensions/ghcp-maestro/extension.mjs`)
  by extracting run-phase, builtin-workflows, and run-command helpers into core.
- **Leaner release archive:** `vscode-extension/`, `scripts/`, and design docs
  under `docs/superpowers/` are `export-ignore`d from the CLI plugin archive.

### Fixed
- **Run Console webview hardening:** escape `U+2028`/`U+2029` in embedded state
  (JS line terminators inside `<script>`) and replace the `script-src
  'unsafe-inline'` CSP with a per-render crypto nonce.
- **Cancellation is honoured end-to-end:** a stopped run skips the synth phase
  and finishes as `stopped` instead of being overridden with `complete`/`error`;
  `aborted`/`stopped`/`cancelled` agents count as terminal and get a distinct
  tree icon.
- **Portability:** `scripts/rebuild-install-stable.ps1` derives the repo root
  from `$PSScriptRoot` and resolves the `code` CLI from `PATH` — no hard-coded,
  username-leaking absolute paths.

## [0.5.0] - 2026-06-30

First tagged release. Highlights since the initial scaffold: the M4 dynamic task
workflow (plan → fan-out → synth), M5 saved workflows, M6 quality helpers, the
M4.x plan pre-approval gate, background runs with on-demand `/maestros`
monitoring, env-configurable agent timeouts, and CI. The runtime is zero-deps.

### Fixed
- **`/maestros <runId>` now shows the plan and synth phases too.** Previously
  only the explore fan-out reported progress, so during the (often minute-plus)
  `plan` decomposition — and the final `synth` — `/maestros <runId>` showed "no
  progress recorded yet" and the run looked stuck. A new `runtime/phase-monitor.mjs`
  (`startPhaseMonitor`) wraps every phase, single-agent or fan-out: it records a
  `pending` snapshot to `progress.json` the instant a phase begins and threads
  the planner/synth streaming (bytes/tokens/state) through, so the phase is
  visible from the moment it starts. Applied across `task` (plan → explore →
  synth), `brainstorm`, and `hello`. New unit tests:
  `tests/phase-monitor.test.mjs`.
- **Task subagents no longer time out on research-heavy runs.** The task
  workflow's plan/explore/synth phases (and the brainstorm lenses) run full
  research subagents — web fetches, repo analysis, many tool calls + extended
  reasoning — whose wall-clock routinely exceeds the old hard-coded 120 s limit,
  so every subtask could fail with `status=timeout` and produce no output.
  Timeouts are now two tiers: research agents default to **10 min**
  (`GHCP_MAESTRO_TIMEOUT_MS`) — matching the ~600 s floor of a single LLM API
  call in the major LLM provider SDKs — and the fixed-prompt diagnostics
  (`pong`/`hello`/env probes) stay short at **1 min**
  (`GHCP_MAESTRO_TIMEOUT_PROBE_MS`) so a slow one still fails fast. When a task
  aborts on timeouts, the failure message points to `GHCP_MAESTRO_TIMEOUT_MS`.
  New unit tests: `tests/timeouts.test.mjs`.

### Changed
- **Diagnostics hidden from `/maestro help`.** `hello` and `pong` are
  infrastructure smoke tests, not user features — they now carry a `hidden` flag
  and render under a separate "Diagnostics" section instead of the main
  subcommand list (the commands still work, and the `GHCP_MAESTRO_PROBE_*` env
  triggers and resume registry are unchanged). The `brainstorm` summary drops the
  "demo" framing — it is a real multi-lens feature. Help rendering moved to a
  pure, unit-tested `runtime/help.mjs` (`renderMaestroHelp`).

### Added
- **Background runs + `/maestros` monitoring (issue #2).** `/maestro
  task|brainstorm|run` (and the `hello` diagnostic) now dispatch in the
  background — the handler returns
  immediately with a `running in background — watch with /maestros <runId>`
  pointer and the session stays free while the fan-out runs. Per-agent progress
  (state, elapsed, streamed bytes, per-phase token totals) is aggregated by
  `runtime/monitor.mjs` and persisted to the run dir as `progress.json`. Watch it
  on demand: `/maestros` lists runs with a one-line progress summary for any still
  running, and `/maestros <runId>` prints the full dashboard. The standalone
  adapter subscribes to each child session's events (`subagent.*`,
  `tool.execution_*`, `assistant.streaming_delta`, `assistant.usage`) through an
  `onProgress` sink threaded by `spawn`/`spawnAll`. Monitoring is best-effort and
  never affects fan-out results; opt out with `GHCP_MAESTRO_NO_MONITOR=1`.
  New/updated unit tests across `tests/monitor.test.mjs`,
  `tests/run-store.test.mjs`, `tests/spawn-progress.test.mjs`,
  `tests/standalone-progress.test.mjs`, `tests/monitor-enabled.test.mjs`.
- **M4.x — plan pre-approval gate.** New `runtime/plan-approval.mjs` adds a
  `planApprovalGate` that runs after the `plan` agent decomposes a task but
  before the fan-out. On an interactive host (`session.capabilities.ui.
  elicitation === true`) it logs the subtask list + prompt previews and shows a
  multi-select elicitation dialog so the user can approve, run only a subset, or
  abort; declining/cancelling marks the run `stopped` with no fan-out. The gate
  fails closed if the dialog errors. Non-interactive hosts (env probes, CI,
  headless), resume replays, and the `GHCP_MAESTRO_AUTO_APPROVE=1` bypass
  approve every subtask automatically, so existing paths keep working. The
  dialog uses stable per-subtask index keys (with `enumNames` labels) so
  duplicate agent names can't collapse a selection. 12 unit tests
  (`tests/plan-approval.test.mjs`).
- **M6 — quality helpers.** New `runtime/quality.mjs` builds four multi-agent
  patterns on top of `spawnAll`, each decoupled from any specific adapter and
  fully unit-tested with scripted adapters:
  - `adversarialReview(findings, { reviewers, threshold })` — independent
    reviewers try to rebut each finding; survivors are those judged valid by at
    least `threshold` of their reviewers.
  - `multiAngle(task, { angles })` — drafts the task from several angles in
    parallel, then a judge agent picks or merges the strongest draft.
  - `fixLoop({ check, applyFix, maxIters })` — re-runs `check` until it passes
    (or `maxIters`), dispatching a fix agent between failed checks.
  - `crossCheck(claims, { sources })` — verifies each claim across multiple
    perspectives and aggregates a support rate.
- **M5 — saved workflows.** New `runtime/saved-workflows.mjs` discovers,
  validates, and runs project/user/bundled workflow scripts:
  - scan order project (`./.ghcp-maestro/workflows` or
    `$GHCP_MAESTRO_WORKFLOWS_DIR`) > user (`<dataDir>/workflows`) > bundled
    (`saved-workflows/`), with kebab-case + reserved-name validation and
    priority-based de-duplication;
  - `buildWorkflowApi` injects a sandboxed `api` (bound `spawn`/`spawnAll`,
    `phase`, `log`, structured `args`, plus the M6 quality helpers) so scripts
    never touch the filesystem, shell, or SDK directly;
  - new commands `/maestro run <name> [json|text args]` and
    `/maestro workflows`; runs persist as `workflow=saved:<name>` so they show
    in `/maestros` and can be resumed;
  - bundled example `saved-workflows/deep-review.mjs`.
- **Dev tooling + CI.** Root `package.json` with `test` / `lint` / `check`
  scripts and an ESLint flat config (`eslint.config.mjs`). The runtime stays
  zero-dependency; ESLint and friends are `devDependencies` only. A
  `no-console` rule enforces JSON-RPC-safe logging in extension/runtime code.
- GitHub Actions: `ci.yml` (ESLint static analysis, `node --check` on every
  tracked `.mjs`, and the `node:test` suite across Node 20 and 22) and
  `codeql.yml` (CodeQL `security-and-quality` analysis).
- 43 new unit tests (`tests/quality.test.mjs`, `tests/saved-workflows.test.mjs`,
  plus `buildPlanPrompt` / `sanitizeAgentName` coverage), and 12 more for the
  M4.x approval gate (`tests/plan-approval.test.mjs`), for a total of 78.

### Changed
- Extension load banner now reads `… (M6 release) …` and reports discovered
  saved workflows.
- Plan generation/parsing extracted from `extension.mjs` into the importable,
  pure `runtime/plan.mjs` (`buildPlanPrompt`, `parseAndValidatePlan`,
  `sanitizeAgentName`). `tests/plan-parse.test.mjs` now imports the module
  directly instead of regex-extracting the function source.
- Resume resolves both built-in and `saved:<name>` workflows via a single
  `resolveWorkflowHandler`.
- Line endings normalized to LF across the tree (per `.gitattributes`); the
  lockfile is now committed so CI can `npm ci` reproducibly.

### Fixed
- **Review hardening (CodeRabbit / CodeQL on PR #1).**
  - `quality.mjs`: `adversarialReview` and `crossCheck` now group agent results
    by an exact per-item spec-id set (folding in the item index) instead of a
    string prefix, so findings/claims whose ids share a prefix (e.g. `a` and
    `a-r1`) can no longer cross-contaminate scores; `crossCheck` maps each
    verdict back to its source explicitly rather than by positional index.
  - `quality.mjs`: `defaultSupportParser` checks negative phrasing first, so
    `NOT SUPPORTED` / `UNSUPPORTED` / `SUPPORTED: NO` are no longer misread as
    supported.
  - `saved-workflows.mjs`: an unreadable (non-`ENOENT`) workflow directory is
    now recorded as `skipped` and skipped instead of aborting the whole scan;
    `parseWorkflowArgs` rejects JSON arrays so structured args are always plain
    objects; `buildWorkflowApi` helper wrappers tolerate a missing `extra` arg.
  - `extension.mjs`: failed resume and a missing saved-workflow descriptor now
    transition the run to `error` instead of leaving it stuck as `running`;
    `task`/`brainstorm` runs fail (status `error`) when every fan-out agent
    fails or when `synth` fails, and log per-agent failures otherwise.
  - `plan.mjs`: agent-id truncation length is now the named `MAX_AGENT_ID_LEN`
    constant instead of a magic number.
  - ESLint bans direct `process.stdout/stderr.write` in extension/runtime code
    (only `session.log()` is JSON-RPC-safe); CI/CodeQL checkouts run with
    `persist-credentials: false`; `plugin.json` declares its `extensions` entry
    and `repository` metadata explicitly.

### M4 (previously unreleased)
- **M4 — meta-prompt task workflow.** `/maestro task <natural-language task>`
  launches a 3-phase run (`plan` → `explore[N]` → `synth`). The `plan` agent
  uses an LLM to decompose the task into 3-6 independent subtasks emitted as a
  JSON spec array; the runtime fans them out through the
  `standalone-client` adapter so each subtask runs in its own isolated
  Copilot CLI session. The `synth` agent merges the outputs.
- `parseAndValidatePlan` — fence-stripping JSON recovery with trailing-comma
  tolerance, schema validation (3-6 entries, unique non-empty `agent`,
  non-empty `prompt`, agent name <=60 chars, prompt <=4000 chars), and a one
  retry pass that feeds the parser error back to the planner.
- `/maestro help` (and `/maestro` with no args) prints all subcommands with
  short summaries, sourced from a single data-driven registry.

## [0.0.3 — M3, 2026-06-29]

### Added
- **M3 — persistence and resume.** New `runtime/run-store.mjs` provides
  `createRun` / `openRun` / `listRuns` and a `RunHandle` API
  (`writeAgent` / `readAgent` / `listAgents` / `patchManifest` / `complete`).
  All writes go through `writeJsonAtomic` (tmp → rename) so a crash mid-write
  never leaves a partial file. Default base directory is
  `~/.copilot/plugin-data/ghcp-maestro/` and can be overridden with the
  `GHCP_MAESTRO_DATA_DIR` env var.
- `spawnAll` and `spawn` accept an optional `runHandle` — when a spec has an
  `id`, the result is persisted and reused on subsequent runs as
  `{ ...cached, cached: true }`.
- Slash commands `/maestros`, `/maestro-resume <runId>`, `/maestro-stop <runId>`
  backed by a workflow registry so resumes replay the original handler with
  the persisted args.
- `runHelloWorkflow` and `runBrainstormWorkflow` updated to use stable agent
  ids so resumes hit the cache.
- 6 new unit tests for the run store (manifest, agent round-trip, atomic
  write, cache hit/miss, `run.complete`).

### Verified
- Initial hello run + same-run resume: wall-clock 7987 ms → 2 ms (full cache
  hit) on the explore phase.
- Crash recovery: deleting a single `agents/<id>.json` and resuming reruns
  only the missing agent; the rest are served from cache.

## [0.0.2 — M2.6, 2026-06-29]

### Added
- **M2.6 — standalone CopilotClient adapter.** New
  `runtime/adapters/standalone-client.mjs` spawns one child Copilot CLI process
  per adapter instance (lazy, reused) and one fresh isolated session per
  spec, so multiple specs really execute in parallel and the host's
  conversation context is never polluted.
- Slash commands `/maestro pong <prompt>` and `/maestro brainstorm <topic>`
  (4 hardcoded lenses + synth) demonstrate the new adapter end-to-end.
- Env-trigger probes (`GHCP_MAESTRO_PROBE_PONG`, `..._HELLO`, `..._BRAINSTORM`)
  for non-interactive validation.

### Notes
- Inside an extension subprocess `process.execPath` already points at the
  sea-loaded `copilot.exe` / native binary. Feeding that path back to the SDK
  via `RuntimeConnection.forStdio({ path: process.execPath })` is what makes
  the nested client work; using the bundled `index.js` triggers the CLI's
  "Invalid command format" guard because commander treats it as a positional
  prompt.

## [0.0.1 — M1+M2, 2026-06-29]

### Added
- **M1 — PoC extension.** `extensions/ghcp-maestro/extension.mjs` loaded by
  the Copilot CLI via `joinSession()`, registers the `/maestro` command, and
  runs a fixed 2-phase, 4-agent in-process script.
- **M2 — concurrency + spawn runtime.** Zero-deps
  `runtime/concurrency.mjs` (`createSemaphore`, `runWithConcurrency`) and
  `runtime/spawn.mjs` (`spawn`, `spawnAll`, `SubagentAdapter`, `dummyAdapter`),
  with `DEFAULT_CONCURRENCY = 16` and `GLOBAL_AGENT_CAP = 1000` as required by
  `docs/REQUIREMENTS.md` §4.4. 14 unit tests covering ordering, cap, error
  propagation, timeout, and pre-aborted signal.
- `runtime/adapters/llm-mediated.mjs` shipped as a documented probe; measured
  to be turn-bound on the host session (no real parallelism) and is therefore
  **not** wired to any production subcommand.
- Plugin manifest (`plugin.json`) at repo root, default
  `extensions/<name>/extension.mjs` layout, MIT licence, initial README.
