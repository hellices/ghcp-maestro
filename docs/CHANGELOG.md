# Changelog

All notable changes to **ghcp-maestro** are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
SemVer. Unreleased work is committed under `Unreleased` until a tag is pushed.

## [Unreleased]

### Added
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
- Unit tests for the plan parser (`tests/plan-parse.test.mjs`, 11 cases).
- README updated with a quickstart, env-trigger examples, and the adapter
  comparison table now naming the workflows wired to each adapter.
- CHANGELOG (this file).

### Changed
- Extension load banner now reads
  `ghcp-maestro extension loaded (M4 release). Run '/maestro help' for subcommands.`
- Removed unused `dummyAdapter` import from `extension.mjs`; the dummy adapter
  remains available to tests through `runtime/spawn.mjs`.
- Documentation (`docs/REQUIREMENTS.md`, `docs/PLAN.md`, `AGENTS.md`) brought
  in line with the implementation: actual extension dir `extensions/ghcp-maestro/`,
  data dir `~/.copilot/plugin-data/ghcp-maestro/`, manifest at repo root,
  adapter (B) ruled out, milestone status (`✅`/`❌`) per phase.

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
