# Action Plan

REQUIREMENTS.md 의 비전을 구체 실행 단계로 분해. 마일스톤 M1~M8 은 REQUIREMENTS §8 참조.

---

## Phase 0 — 사전 조사 (완료)

### 0.1 GHCP plugin / extension 구조 분석

확인 대상:
- [GHCP CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- `@github/copilot-sdk` npm 패키지 (`/extension` / `CopilotClient` surface)
- GHCP CLI 내장된 SDK 부트스트랩 (extension subprocess spawn 흐름)
- `awesome-copilot` repo 의 extension 예시 (`feedback-themes` 등)

발췌해야 할 것:
- subagent fan-out 가능한 SDK API
- plugin.json / extension 매니페스트 실제 예시
- `joinSession()` 호출 보일러플레이트

### 0.2 GHCP CLI extension SDK 실측

이론 vs 실제 차이 확인:
- `@github/copilot-sdk` 의 export surface (`/extension`, `CopilotClient`)
- `joinSession({ commands, tools, hooks, customAgents, infiniteSessions })` 실제 옵션
- `session.send` / `sendAndWait` / `on` / `ui.elicitation` / `setModel` 가용성
- 내장 `task` tool 호출 시그니처 (subagent 디스패치)
- 알려진 버그 (hook overwrite 등) 현재 상태

검증 방법: 빈 extension 만들어서 `session.capabilities` 출력 + 각 API try-catch 호출

### 0.3 Open question 1차 답변

- Q1 Standalone SDK 통합 시점: M8 → 실제로는 M2.6 으로 앞당겨 채택 (`standalone-client` adapter)
- Q2 메타 프롬프트 모델: 현재 child session 기본 모델
- Q3 VS Code surface: GHCP extension 검증(M4) 후 M7 진행 예정
- Q4 저장된 워크플로우 슬래시: 동적 등록 — M5
- Q5 빌드: 현재 zero-deps `.mjs` 직접 운영, M6 이후 재검토
- Q6 메모리/Resume 보조: 외부 의존 없이 RunStore 직접 구현 (M3)

→ M4 시점에 재확정 — `docs/REQUIREMENTS.md` §10 참고.

---

## Phase 1 — M1 PoC

### 1.1 디렉토리 골격 (실제 채택)

```
ghcp-maestro/                     # repo == plugin root
├── plugin.json                   # GHCP plugin manifest (root, docs 기본)
├── extensions/
│   └── ghcp-maestro/             # SDK extension component (joinSession)
│       ├── extension.mjs         # 진입점
│       └── package.json          # type:module, main:extension.mjs
├── docs/
│   ├── REQUIREMENTS.md
│   └── PLAN.md
├── AGENTS.md
├── README.md
└── LICENSE
```

> 실제 채택: `src/` 디렉토리 안 만들고 모두 `extensions/ghcp-maestro/runtime/` 아래 통합 (concurrency, spawn, run-store, adapters/). M2~M4 진행 결과 zero-deps `.mjs` 직접 운영이 충분히 깔끔 — esbuild 도입은 helper 라이브러리(M6)가 늘어나면 재검토.

### 1.2 M1 acceptance criteria

- [x] `copilot --experimental` 세션 시작 시 ghcp-maestro extension 로드 (로그 `Extension ready: …extension.mjs`)
- [x] `/maestro hello` 슬래시 등록 (CLI command registry 에 등록 확인 — TUI 호출은 사용자 검증 영역)
- [x] 핸들러가 하드코딩 스크립트 1개 실행 (phase 2개, 더미 agent 4개)
- [ ] 각 agent 가 내장 `task` tool 호출 → 결과 수집 *(M2 로 이연 — 현재 inline dummy spawn)*
- [x] 완료 로그 + 결과 요약을 `session.log` 로 출력
- [ ] `/extensions reload` 로 핫리로드 동작 *(수동 재설치만 검증; experimental surface — 추후 확인)*
- [x] `package.json` `type: "module"`, ESM only

### 1.3 비기능 요건

- 의존성 최소화 (런타임은 zero deps 목표)
- `session.log` 만 사용 (stdout 직접 출력 금지 — JSON-RPC 깨짐)
- Tool name prefix: `ghcp_maestro_*` (collision 방지)

---

## Phase 2 — M2 동시성 / Spawn 어댑터 (완료)

### 산출물
- `extensions/ghcp-maestro/runtime/concurrency.mjs` — zero-deps semaphore + `runWithConcurrency`
- `extensions/ghcp-maestro/runtime/spawn.mjs` — `spawn`, `spawnAll`, `SubagentAdapter` 인터페이스, `dummyAdapter`, `GLOBAL_AGENT_CAP=1000`, `DEFAULT_CONCURRENCY=16`
- `tests/concurrency.test.mjs` + `tests/spawn.test.mjs` — 14 테스트 통과 (`node --test`)
- `extension.mjs` — `/maestro hello` 가 새 runtime `spawnAll(dummyAdapter)` 사용

### M2 acceptance criteria
- [x] `spawnAll(specs[], { concurrency })` 구현 + 입력 순서 보존
- [x] 자체 p-queue 유사 (zero-deps semaphore)
- [x] 글로벌 cap 1000 enforce + RangeError
- [x] 어댑터 인터페이스 확정 (dummy 구현, LLM-mediated / agentRegistry.spawn 는 M2.5+M8)
- [x] 단위 테스트: 동시성 cap / ordering / 에러 propagation / timeout / pre-aborted signal

### 어댑터 후보 (M2.5 이후)
- **LLM-mediated**: `session.sendAndWait("/agent ... ")` — LLM 이 내장 task tool 호출, 결과 event 캡처. 비용 ↑ 속도 ↓ 정확도 ↑
- **agentRegistry.spawn (heavy)**: `session.rpc.agentRegistry.spawn({ cwd, agentName, model, initialPrompt })` — 새 managed-server child fork. 진짜 병렬, 비용 가장 큼
- SDK 는 LLM 우회한 **직접 task tool 호출 surface 없음** (확인 완료)

---

## Phase 2.5 — LLM-mediated adapter prototype (완료, mismatch 확인)

`extensions/ghcp-maestro/runtime/adapters/llm-mediated.mjs` 작성, env probe 로 실측.
**결론**: (A) 는 user session 의 turn lifecycle 에 종속 — 진짜 fan-out 불가. 폐기.

---

## Phase 2.6 — Standalone CopilotClient adapter (완료, 실제 fan-out 검증)

### 산출물
- `extensions/ghcp-maestro/runtime/adapters/standalone-client.mjs` — `new CopilotClient(RuntimeConnection.forStdio({ path: process.execPath }))` + per-spec `createSession` → `sendAndWait` → `disconnect`. Lazy boot + reuse.
- `extension.mjs` — `/maestro hello` 가 standalone adapter 로 swap. `/maestro pong <prompt>` 단일-spec probe. `GHCP_MAESTRO_PROBE_PONG`, `GHCP_MAESTRO_PROBE_HELLO` ENV trigger.
- 핵심 trick: extension 의 `process.execPath` 는 sea-loaded `copilot.exe`. SDK 의 `spawn(cliPath, args)` 가 `.js` 아닐 때 직접 호출하므로 execPath 를 그대로 cliPath 로 주면 동작. `index.js` 를 cliPath 로 주면 commander 가 "Invalid command format" 에러.

### 실측 (2026-06-29 13:31, 3-spec fan-out)
```
phase=explore agents=3 (parallel)
explore/explore-a status=ok took=6481ms reply="ALPHA"
explore/explore-b status=ok took=6715ms reply="BRAVO"
explore/explore-c status=ok took=6391ms reply="CHARLIE"
phase=explore wall-clock=6805ms (parallel of 3)         ← 진짜 병렬
phase=synth agents=1
synth status=ok took=2655ms reply="ALPHA BRAVO CHARLIE" ← 다음 phase 에 결과 전달
hello workflow complete (4 agents across 2 phases)
```

### M2.6 acceptance criteria
- [x] standalone client adapter (SubagentAdapter 만족)
- [x] 진짜 isolated child Copilot session 생성 + 결과 회수
- [x] N spec 동시 실행 (3-spec wall-clock ≈ 가장 느린 spec 1개)
- [x] 다음 phase 가 이전 phase 결과 활용
- [x] 호스트 session context 격리 (host tokens = user prompt 만)

### 동작 확인 차원
| 차원 | 상태 |
|---|---|
| spec → child agent | ✅ |
| 진짜 병렬 (concurrency cap 16) | ✅ |
| 결과 → 다음 phase | ✅ |
| 호스트 context 격리 | ✅ |

---

## Phase 3 — M3 상태 / Resume (완료)

### 산출물
- `extensions/ghcp-maestro/runtime/run-store.mjs` — RunStore 영속화 layer:
  - `createRun({workflow, args})` / `openRun(runId)` / `listRuns()`
  - `runHandle.writeAgent / readAgent / listAgents / patchManifest / complete`
  - atomic write (tmp → rename) — crash-safe
  - 디폴트 경로: `~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/`
- `runtime/spawn.mjs` — `spawnAll(..., { runHandle })`: cache 자동 lookup/write, `result.cached: true` 표시
- `extension.mjs` — workflow registry (`hello`, `brainstorm`), `/maestros`/`/maestro-resume <id>`/`/maestro-stop <id>` slashes
- `tests/run-store.test.mjs` — 6 케이스 (manifest, agent round-trip, atomic, cache hit/miss, complete)

### 실측 (2026-06-29 13:40)
**Step 1 — 초기 hello run (실제 LLM)**:
```
phase=explore wall-clock=7987ms (parallel of 3)
synth status=ok took=3066ms
```
**Step 2 — 같은 runId resume (전체 cache hit)**:
```
explore/explore-a status=ok (cached) took=7904ms
phase=explore wall-clock=2ms (parallel of 3)        ← 7987ms → 2ms
synth status=ok (cached) wall=1ms                   ← 3066ms → 1ms
```
**Step 3 — explore-b 파일만 지운 후 resume (부분 복구)**:
```
explore-a (cached) | explore-b ok 6684ms | explore-c (cached)
phase=explore wall-clock=6687ms (parallel of 3)     ← 지운 것만 다시 호출
```

### M3 acceptance criteria
- [x] `${BASEDIR}/runs/<runId>/` 스키마 (manifest + agents/)
- [x] atomic write (tmp → rename)
- [x] `/maestros` 목록
- [x] `/maestro-resume <id>` — cached 결과 skip, 미완료만 재실행
- [x] `/maestro-stop <id>` — manifest status=stopped 표시
- [x] crash recovery 시나리오 (부분 삭제 후 resume)
- [x] 단위 테스트 (6 케이스, 총 20 통과)

---

## Phase 4 — M4 메타 프롬프트 (완료)

### 산출물
- `extension.mjs` 의 `runTaskWorkflow(session, task)` — 3-phase 자동 동적 분할:
  1. **plan** (1 agent): 메타 프롬프트 + JSON schema 검증, parse 실패 시 parser-error 포함해 1회 retry
  2. **explore** (N agent, N∈[3,6]): plan 결과 spec 배열 → `spawnAll(standaloneAdapter)` 진짜 병렬
  3. **synth** (1 agent): 모든 explore 결과 cross-check 후 최종 답변 + next actions
- `parseAndValidatePlan(text)` — fence strip, array bracket fallback, 길이 3-6, agent 중복 검사
- `/maestro task <자연어>` slash + `GHCP_MAESTRO_PROBE_TASK` env trigger
- `WORKFLOWS.task` 등록 → M3 RunStore / resume 와 자동 통합

### 실측 (2026-06-29 14:30)
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
phase=explore wall-clock=62944ms (parallel of 5)   ← 합 156s → 실제 63s

phase=synth agents=1   took=16144ms
FINAL ANSWER: 보류 — REQUIREMENTS §2 위반, M4 미완, 단일 개발자엔 과잉 …
  + Next Actions 5개 (M4 우선 / progress 콜백 / TUI 사이드카 / M7 Webview)

task workflow complete — 7 agents across 3 phases
```

### M4 acceptance criteria
- [x] 자연어 task 1줄 입력
- [x] LLM 이 3-6 independent subtask 로 자동 분할 (JSON 배열)
- [x] schema 검증 + 1회 retry (parser-error feedback 포함)
- [x] subtask 진짜 병렬 (wall-clock = max(subtasks), not sum)
- [x] synth 가 모든 결과 cross-check 후 최종 답변
- [x] RunStore 영속화 + resume 자동 통합 (3-phase 모두 cache 가능)

### M4 동작 요약
| 차원 | 상태 |
|---|---|
| 분해 주체 (LLM `plan` agent) | ✅ |
| 진짜 병렬 | ✅ (실측 wall-clock 63s ≈ max(subtask)) |
| 컨텍스트 격리 | ✅ (5 isolated child sessions) |
| 결과 → 다음 phase | ✅ |
| Resume + cache | ✅ |
| Plan 사전 승인 UI | ❌ M4.x 로 이연 |
| 스크립트 코드 export | ❌ M5 (현재는 plan JSON 만 영속) |

---

## Phase 5 — M5 저장 / 재실행 (다음)

- `saved-workflows/<name>.mjs` 디렉토리
- extension 로드 시 스캔 → `joinSession({ commands })` 에 동적 추가 등록 (`/<name>` 또는 단일 `/maestro run <name>` dispatcher)
- `args` 전역 inject (M4 task workflow 와 같은 채널)
- 이름 충돌 시 프로젝트 > 개인 우선
- (선택) M4.x — `session.ui.elicitation` 으로 plan 결과 (subtask 목록 + 각 prompt preview) 사전 승인 UI

---

## Phase 6 — M6 품질 helper

`extensions/ghcp-maestro/runtime/quality/` 모듈:
- `adversarialReview(findings, { reviewers })`
- `multiAngle(task, { angles })`
- `fixLoop({ build, test, maxIters })`
- `crossCheck(claims, { sources })`

각 helper 는 위 `spawnAll` 위에 구축. multi-reviewer voting 으로 신뢰도 스코어링하는 패턴 등 multi-agent quality pattern 차용.

---

## Phase 7 — M7 VS Code 부 surface

- 새 디렉토리 `vscode-extension/` (별도 패키지)
- `vscode.chat.createChatParticipant('ghcp-maestro.workflow', handler)`
- `vscode.lm.selectChatModels` + `sendRequest`
- 코어 (`extensions/ghcp-maestro/runtime/`) 공유 import
- 진행상황 TreeView `workflowsView`

---

## Phase 8 — M8 Standalone SDK fork (M2.6 에서 선행 완료)

이 Phase 의 핵심 — `CopilotClient` + 새 N session fan-out — 은
M2.6 `standalone-client` adapter 로 이미 구현/실측 완료.
남은 작업은 비용/속도 가이드 문서화와, 필요 시 BYOK provider/model
routing 등 고급 옵션 노출.

---

## 검증 / 릴리스 체크리스트

각 Phase 마지막:
- [ ] 단위 테스트 통과
- [ ] 수동 시나리오 1개 (간단 작업) end-to-end 동작
- [ ] `/extensions info ghcp-maestro` 로 등록 surface 확인
- [ ] README 사용 예시 업데이트
- [ ] CHANGELOG 항목 추가
- [ ] 알려진 한계 / 격차 문서화

릴리스 (M5 이후):
- [ ] `.github/plugin/marketplace.json` 작성
- [ ] `copilot plugin install ...` 흐름 테스트
- [ ] 라이센스 / 보안 검토
- [ ] 데모 스크립트 (`/deep-research` 유사) 1개

---

## 다음 즉시 액션

Phase 4 / M4 완료. 다음:

1. **M4.x** (선택, 작음): `session.ui.elicitation` 으로 plan 결과 (subtask 목록 + 각 prompt 미리보기) 사전 승인 UI
2. **M5** saved workflows — `saved-workflows/<name>.mjs` 동적 슬래시 + `args` global. `extensions/ghcp-maestro/extension.mjs` 로드 시 스캔 → 추가 commands 등록.
3. **M6** quality helpers — `adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck` (`spawnAll` 위에 구축)
4. **M7** VS Code surface — 별도 `vscode-extension/` 패키지, chat participant + TreeView
5. **릴리스 준비** — `marketplace.json`, `copilot plugin install` 흐름 검증, 데모 가이드, 보안 검토
