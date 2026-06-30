# ghcp-maestro

Multi-agent workflow runtime for GitHub Copilot CLI.

`/maestro task <자연어 task>` 한 줄이면 plan agent 가 task 를 3-6 subtask 로
자동 분할 → 격리된 child Copilot 세션들이 진짜 병렬로 실행 → synth agent 가
결과를 cross-check 해서 최종 답변 + next actions 를 돌려준다. 디스크에
영속화되어 `/maestro-resume <runId>` 로 부분 재실행 가능.

> Status: **M6 release ready**. Plan → fan-out (max 16 concurrent, 1000 total)
> → synth, run persistence + resume, plan parser hardening, saved workflows,
> multi-agent quality helpers, plan pre-approval gate, ESLint + CodeQL CI, 77 단위 테스트.
> 진행 상황은 [docs/PLAN.md](docs/PLAN.md), 스펙은 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md),
> 변경 이력은 [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## What it does

- 자연어 task 1줄 → LLM 이 자동으로 독립 subtask 로 분할 (`plan` agent)
- N 개 subtask 가 격리된 child Copilot 세션에서 진짜 병렬 실행
- 결과를 다음 phase 가 cross-check 후 최종 답변 합성 (`synth` agent)
- 모든 run 이 디스크에 영속화 — 부분 실패 시 미완료 agent 만 다시 실행
- 호스트 세션 conversation context 는 오염되지 않음 (subagent 컨텍스트 격리)
- GitHub Copilot CLI plugin 으로 배포 — 별도 외부 CLI 없음

## Install (local development)

GitHub Copilot CLI 의 experimental **extensions** surface 를 사용하므로
`--experimental` 가 필요하다 (또는 `/experimental` 슬래시 후 persist).

```powershell
# From the repo root
copilot plugin install (Get-Location)

# Verify
copilot plugin list                              # should show ghcp-maestro
copilot --experimental -p "say OK"               # should print '● ghcp-maestro extension loaded (M6 release). Run /maestro help for subcommands.'

# Iterate
copilot plugin uninstall ghcp-maestro
copilot plugin install (Get-Location)
```

On macOS / Linux substitute `$(pwd)` for `(Get-Location)`.

## Usage

In an interactive session started with `--experimental`:

```
/maestro help                        # list subcommands
/maestro task <자연어 task>           # LLM 이 task 를 3-6 subtask 로 자동 분할 → (대화형 host면 사전 승인) → 격리된 child session 들에서 fan-out → synth
/maestro brainstorm <topic>          # 4 lens-specific agents → synth across lenses
/maestro hello                       # 3 explore + 1 synth, isolated child sessions
/maestro pong <prompt>               # single-spec standalone-client probe
/maestro workflows                   # list discovered saved workflows
/maestro run <name> [args]           # run a saved workflow (args: JSON object or plain text → {input})
/maestros                            # list recent runs (newest first)
/maestro-resume <runId>              # replay a run; cached agents skipped, missing ones rerun
/maestro-stop <runId>                # mark a run as stopped (no in-flight kill)
```

> **The fast path:**
> ```
> /maestro task <한 줄 자연어 task>
> ```

Or non-interactively via env triggers (slash commands are *not* auto-dispatched in `-p` mode):

```powershell
# Pick one of:
$env:GHCP_MAESTRO_PROBE_HELLO      = "1"
$env:GHCP_MAESTRO_PROBE_BRAINSTORM = "your topic here"
$env:GHCP_MAESTRO_PROBE_TASK       = "your natural-language task here"
$env:GHCP_MAESTRO_PROBE_RUN        = "deep-review {\"topic\":\"...\"}"
$env:GHCP_MAESTRO_PROBE_PONG       = "Reply with the single word PONG"
$env:GHCP_MAESTRO_PROBE_RESUME     = "<runId>"

copilot --experimental -p "wait 240 seconds then reply DONE" --allow-all-tools
```

On an interactive host, `/maestro task` pauses after planning to show the
subtasks and ask for approval (you can run only a subset or abort). Set
`GHCP_MAESTRO_AUTO_APPROVE=1` to skip the prompt and always fan out — resume
replays and non-interactive (`-p` / headless) runs auto-approve anyway.

The long user prompt keeps the host session alive while the env-triggered
workflow finishes — `-p` mode otherwise SIGTERM-s the extension as soon as
the user turn completes.

### Roadmap

Done: M1 PoC · M2 spawn runtime · M2.6 standalone fan-out · M3 persistence/resume ·
M4 meta-prompt task workflow · **M5 saved workflows** · **M6 quality helpers** ·
ESLint + CodeQL CI.

Next:

- **M4.x** — `session.ui.elicitation` 으로 plan 결과 사전 승인 UI
- **M7** — VS Code chat participant (별도 패키지)

### Saved workflows (M5)

A saved workflow is an ESM module that default-exports an async function and is
discovered from (highest priority first):

1. project — `$GHCP_MAESTRO_WORKFLOWS_DIR` or `./.ghcp-maestro/workflows`
2. user — `<dataDir>/workflows` (`~/.copilot/plugin-data/ghcp-maestro/workflows`)
3. bundled — `extensions/ghcp-maestro/saved-workflows/`

```js
// my-workflow.mjs
export const description = "One line shown in /maestro workflows";
export default async function run(api) {
  const { args, log, spawnAll, multiAngle, phase } = api;
  await phase("draft", () => multiAngle(args.topic ?? args.input, { angles: ["a", "b"] }));
}
```

The injected `api` is the only surface a workflow may use — `spawn`, `spawnAll`,
`phase`, `log`, `args`, and the quality helpers, all pre-bound to the
standalone adapter and the current run (so caching/resume work). Scripts never
touch the filesystem, shell, or SDK directly. Run with
`/maestro run <name> [json|text args]`. The bundled `deep-review` workflow is a
worked example.

### Quality helpers (M6)

`runtime/quality.mjs` provides reusable multi-agent patterns on top of
`spawnAll`, available to saved workflows through `api`:

| Helper | What it does |
| :-- | :-- |
| `adversarialReview(findings, opts)` | Independent reviewers rebut each finding; keep those passing a threshold |
| `multiAngle(task, opts)` | Draft from several angles in parallel, judge picks/merges the best |
| `fixLoop(opts)` | Re-run `check` until clean (or `maxIters`), dispatching a fix agent between tries |
| `crossCheck(claims, opts)` | Verify each claim across multiple sources, aggregate a support rate |

### Adapters

| Adapter | Module | When to use | Real isolation? | Real parallelism? |
| :-- | :-- | :-- | :-- | :-- |
| `dummy` | `runtime/spawn.mjs` | Tests, deterministic runtime checks | No | Yes (no LLM) |
| `llm-mediated` | `runtime/adapters/llm-mediated.mjs` | Lightweight probe; serialised on host turns | No (same session) | No (turn-based) |
| `standalone-client` | `runtime/adapters/standalone-client.mjs` | Real fan-out — one isolated child Copilot CLI session per spec | **Yes** | **Yes (concurrency-capped, default 16)** |

`/maestro task`, `/maestro brainstorm`, `/maestro hello`, `/maestro pong`, and
saved workflows (`/maestro run`) are all wired to the `standalone-client`
adapter. It spawns one child Copilot CLI process per adapter instance (lazy
boot, reused across invocations) and one fresh isolated session per spec.

## Repository layout

```
ghcp-maestro/
├── plugin.json                              # GHCP plugin manifest (root)
├── package.json                             # dev/CI workspace (test/lint scripts; runtime stays zero-deps)
├── eslint.config.mjs                        # ESLint flat config (static analysis)
├── .github/workflows/
│   ├── ci.yml                               # ESLint + node --check + node:test (Node 20/22)
│   └── codeql.yml                           # CodeQL security-and-quality analysis
├── extensions/ghcp-maestro/                 # SDK extension component
│   ├── extension.mjs                        # joinSession() + /maestro* commands + env probes
│   ├── package.json                         # type:module, main:extension.mjs
│   ├── saved-workflows/                     # bundled saved workflows (e.g. deep-review.mjs)
│   └── runtime/
│       ├── concurrency.mjs                  # semaphore + runWithConcurrency
│       ├── spawn.mjs                        # spawn / spawnAll + dummyAdapter (+ runHandle cache)
│       ├── run-store.mjs                    # RunStore: manifest + per-agent JSON, atomic writes
│       ├── plan.mjs                         # task-decomposition prompt + plan parser/validator
│       ├── quality.mjs                      # M6 quality helpers (adversarialReview, multiAngle, …)
│       ├── saved-workflows.mjs              # M5 discovery, validation, sandboxed api
│       └── adapters/
│           ├── llm-mediated.mjs             # session.sendAndWait probe
│           └── standalone-client.mjs        # CopilotClient child sessions — real fan-out
├── tests/
│   ├── concurrency.test.mjs
│   ├── spawn.test.mjs
│   ├── run-store.test.mjs
│   ├── plan-parse.test.mjs
│   ├── quality.test.mjs
│   └── saved-workflows.test.mjs
├── docs/
│   ├── REQUIREMENTS.md
│   ├── PLAN.md
│   └── CHANGELOG.md
├── AGENTS.md
├── LICENSE
└── README.md
```

Runs are persisted under `~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/`
(override with `GHCP_MAESTRO_DATA_DIR`). Each run has `manifest.json` and one
`agents/<agentId>.json` per subagent.

## Tests

The runtime is zero-dependency, so the suite runs with vanilla Node.js:

```powershell
node --test tests/*.test.mjs
```

Or, with the dev tooling installed (`npm install`), use the workspace scripts:

```powershell
npm test          # node --test tests/*.test.mjs
npm run lint      # ESLint static analysis
npm run check     # lint + test (what CI runs)
```

77 cases (concurrency × 7, spawn × 7, run-store × 6, plan parser × 16,
quality × 19, saved-workflows × 11, plan-approval × 11). CI (`.github/workflows/ci.yml`)
runs lint + `node --check` + tests on Node 20 and 22; CodeQL runs static security analysis.

The repo *is* the plugin: `copilot plugin install <repo>` copies the whole
tree into `~/.copilot/installed-plugins/_direct/ghcp-maestro/`. Dev files
(`docs/`, `tests/`, `AGENTS.md`) are included in that copy but ignored at
runtime.

## Requirements

- GitHub Copilot CLI ≥ 1.0.65 (Node.js 20+)
- `--experimental` flag (or `/experimental` persisted) to enable the
  extensions surface

## License

MIT — see [LICENSE](LICENSE).
