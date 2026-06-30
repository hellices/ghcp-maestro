# ghcp-maestro

Multi-agent workflow runtime for GitHub Copilot CLI.

`/maestro task <자연어 task>` 한 줄이면 plan agent 가 task 를 3-6 subtask 로
자동 분할 → 격리된 child Copilot 세션들이 진짜 병렬로 실행 → synth agent 가
결과를 cross-check 해서 최종 답변 + next actions 를 돌려준다. 디스크에
영속화되어 `/maestro-resume <runId>` 로 부분 재실행 가능.

> Status: **M4 release ready**. Plan → fan-out (max 16 concurrent, 1000 total)
> → synth, run persistence + resume, plan parser hardening, 31 단위 테스트.
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
copilot --experimental -p "say OK"               # should print '● ghcp-maestro extension loaded (M4 release). Run /maestro help for subcommands.'

# Iterate
copilot plugin uninstall ghcp-maestro
copilot plugin install (Get-Location)
```

On macOS / Linux substitute `$(pwd)` for `(Get-Location)`.

## Usage

In an interactive session started with `--experimental`:

```
/maestro help                        # list subcommands
/maestro task <자연어 task>           # LLM 이 task 를 3-6 subtask 로 자동 분할 → 격리된 child session 들에서 fan-out → synth
/maestro brainstorm <topic>          # 4 lens-specific agents → synth across lenses
/maestro hello                       # 3 explore + 1 synth, isolated child sessions
/maestro pong <prompt>               # single-spec standalone-client probe
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
$env:GHCP_MAESTRO_PROBE_PONG       = "Reply with the single word PONG"
$env:GHCP_MAESTRO_PROBE_RESUME     = "<runId>"

copilot --experimental -p "wait 240 seconds then reply DONE" --allow-all-tools
```

The long user prompt keeps the host session alive while the env-triggered
workflow finishes — `-p` mode otherwise SIGTERM-s the extension as soon as
the user turn completes.

### Roadmap (post-M4)

- **M4.x** — `session.ui.elicitation` 으로 plan 결과 사전 승인 UI
- **M5** — `saved-workflows/<name>.mjs` 동적 슬래시 + `args` global
- **M6** — quality helpers (`adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck`)
- **M7** — VS Code chat participant (별도 패키지)

### Adapters

| Adapter | Module | When to use | Real isolation? | Real parallelism? |
| :-- | :-- | :-- | :-- | :-- |
| `dummy` | `runtime/spawn.mjs` | Tests, deterministic runtime checks | No | Yes (no LLM) |
| `llm-mediated` | `runtime/adapters/llm-mediated.mjs` | Lightweight probe; serialised on host turns | No (same session) | No (turn-based) |
| `standalone-client` | `runtime/adapters/standalone-client.mjs` | Real fan-out — one isolated child Copilot CLI session per spec | **Yes** | **Yes (concurrency-capped, default 16)** |

`/maestro task`, `/maestro brainstorm`, `/maestro hello`, `/maestro pong` are
all wired to the `standalone-client` adapter. It spawns one child Copilot CLI
process per adapter instance (lazy boot, reused across invocations) and one
fresh isolated session per spec.

## Repository layout

```
ghcp-maestro/
├── plugin.json                              # GHCP plugin manifest (root)
├── extensions/ghcp-maestro/                 # SDK extension component
│   ├── extension.mjs                        # joinSession() + /maestro* commands + env probes
│   ├── package.json                         # type:module, main:extension.mjs
│   └── runtime/
│       ├── concurrency.mjs                  # semaphore + runWithConcurrency
│       ├── spawn.mjs                        # spawn / spawnAll + dummyAdapter (+ runHandle cache)
│       ├── run-store.mjs                    # RunStore: manifest + per-agent JSON, atomic writes
│       └── adapters/
│           ├── llm-mediated.mjs             # session.sendAndWait probe
│           └── standalone-client.mjs        # CopilotClient child sessions — real fan-out
├── tests/
│   ├── concurrency.test.mjs
│   ├── spawn.test.mjs
│   ├── run-store.test.mjs
│   └── plan-parse.test.mjs
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

Zero deps. Run with vanilla Node.js (no `npm install` required):

```powershell
node --test tests/concurrency.test.mjs tests/spawn.test.mjs tests/run-store.test.mjs tests/plan-parse.test.mjs
```

31 cases as of M4 (concurrency × 7, spawn × 7, run-store × 6, plan parser × 11).

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
