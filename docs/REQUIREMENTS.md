# ghcp-maestro — Specification

GitHub Copilot CLI 위에 동작하는 multi-agent workflow runtime. 자연어 task
한 줄을 LLM 이 자동 분할 → 격리된 child Copilot 세션들이 진짜 병렬로 실행 →
결과 종합까지를 plugin 한 묶음으로 제공한다.

참고:
- [GHCP CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [GHCP CLI extensions guide (htek.dev)](https://htek.dev/articles/github-copilot-cli-extensions-complete-guide)

---

## 1. 목표

- 한 작업 → 수십~수백 subagent 병렬 오케스트레이션
- 계획을 **스크립트로 코드화** (호스트 LLM 컨텍스트 밖에서 보관)
- 백그라운드 실행, 세션 점유 안 함
- 결과 캐시 + 재개 가능
- 워크플로우 저장/재사용 (`/<name>` 슬래시 커맨드)
- **GHCP harness 내장 패턴** — 별도 외부 CLI 만들지 않음

## 2. 비목표

- UI, 데스크탑앱, IDE 통합 (M7 별도 패키지 예정)
- GHCP CLI 자체 재구현 X
- 외부 LLM 직접 호출 X (GHCP 전용)
- 새로운 LLM 게이트웨이 X

---

## 3. 배포 형태 (Two Surfaces)

### 3.1 메인: GHCP CLI extension

- 위치: `extensions/ghcp-maestro/extension.mjs` (plugin manifest 는 repo root 의 `plugin.json` 기본 위치)
- SDK: `@github/copilot-sdk/extension` 의 `joinSession()`
- Node.js child process + JSON-RPC over stdio
- ESM `.mjs` 직접 (현재 zero-deps, 빌드 단계 없음)
- 실험 surface — `copilot --experimental` (EXTENSIONS feature flag) 필수
- 핫리로드는 `copilot plugin install <repo>` 재실행으로 검증 (`/extensions reload` 는 추후 확인)

### 3.2 보조: VS Code Copilot Chat 참가자

- `vscode.chat.createChatParticipant('ghcp-maestro.workflow', handler)`
- **`@workflow` 멘션 또는 `/maestro` 슬래시** (VS Code surface — 멘션 이름 추후 결정)
- `vscode.lm.selectChatModels` + `sendRequest` 로 모델 호출
- 진행상황은 `stream.progress/markdown/button` + 별도 TreeView/Webview
- 핵심 코어 로직은 공유, 어댑터만 분리

### 3.3 공유 코어

- 워크플로우 런타임 / 동시성 제한 / 결과 캐시 / 품질 helper
- 양 surface에서 import 가능한 `.mjs` 모듈 (현재 zero-deps; TypeScript 도입은 M6 이후 재검토)
- 외부 LLM 호출 직접 안 함 — 어댑터 인터페이스를 통해서만

---

## 4. 핵심 요구사항

### 4.1 슬래시 커맨드

extension `joinSession({ commands })` 로 등록.

- `/maestro <subcommand>` — dispatch:
  - `/maestro task <자연어>` — 메타 프롬프트로 LLM 이 spec 분할 → fan-out (M4)
  - `/maestro brainstorm <topic>` — hardcoded 4-각도 (tech/ux/biz/risk) → synth (데모용)
  - `/maestro hello` — 3 explore + 1 synth 고정 데모
  - `/maestro pong <prompt>` — 단일 standalone-client spec probe
  - `/maestro echo <prompt>` — 단일 LLM-mediated probe (host-bound, limited)
- `/maestros` — RunStore 의 최근 run 목록
- `/maestro-stop <id>`, `/maestro-resume <id>` — RunStore 기반 stop / resume
- 저장된 워크플로우는 M5 에서 동적 등록 (이름 충돌 정책 미정)

### 4.2 스크립트 모델

- 형식: ES module (`.mjs`)
- 런타임이 inject한 글로벌 API 사용 (스크립트 자체는 FS/shell 직접 호출 금지)
- 글로벌 API (초안):
  - `spawn({ prompt, agent?, allowedTools?, model? }) → Promise<AgentResult>` — 내장 `task` tool 또는 standalone SDK 호출로 구현
  - `spawnAll(specs[]) → Promise<AgentResult[]>` — 동시성 자동 제한
  - `phase(name, fn)` — 진행상황 그룹
  - `args` — saved workflow 호출 시 구조화 입력
  - `log(msg)` → `session.log()`
  - 품질 helper: `adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck`

### 4.3 Subagent 호출 어댑터

SubagentAdapter 인터페이스 (`{ name, invoke(spec, ctx) }`) — runtime 은 어댑터를 통해서만 child agent 호출.

실측 후 채택 / 폐기:

- (a) **`session.sendAndWait`** (LLM-mediated, `llmMediatedAdapter`) — host session turn lifecycle 종속 → 진짜 fan-out 불가, 폐기 (probe 코드만 유지)
- (b) **`session.rpc.agentRegistry.spawn`** — SDK `d.ts` 만 존재, 런타임 surface 미노출 (`undefined`) → 사용 불가
- (c) **Standalone `CopilotClient`** (`createStandaloneClientAdapter`) — 채택. `process.execPath`(sea-loaded `copilot.exe`)를 `RuntimeConnection.forStdio({ path })` 로 주고, per-spec `createSession`/`sendAndWait`/`disconnect`. **진짜 격리 + 진짜 병렬**.

스크립트는 어댑터를 직접 import (`{ adapter: standalone }`) — 호출부에서 mode flag 없음.

### 4.4 동시성 / cap

- 기본 동시 16 (CPU/설정 기반 조정)
- 글로벌 cap 1000 agent/run
- per-phase cap 옵션

### 4.5 상태 / 영속화

- 디폴트 위치: `~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/` (override: `GHCP_MAESTRO_DATA_DIR` env)
- 파일:
  - `manifest.json` — workflow, args, status (`running`/`complete`/`stopped`/`error`), startedAt / finishedAt
  - `agents/<agentId>.json` — spec + status + output/error + 시간
  - (M5 예정) `script.mjs` — 저장된 워크플로우 코드 사본
- Resume: `runHandle` 을 통해 `spawnAll` 이 자동 캐시 lookup → 있으면 `result.cached: true`, 없으면 adapter 호출 → write
- atomic write (tmp → rename), 부분 crash recovery 검증 통과
- `infiniteSessions` 통합은 M7 (VS Code surface) 이후

### 4.6 메타 프롬프트 (스크립트 생성기)

- `/maestro task <자연어>` 호출 시 (M4 구현):
  1. `plan` agent (standalone child session) 가 메타 프롬프트로 task 분석 → `[{agent, prompt}]` JSON 배열 생성
  2. parser 가 schema 검증 (3-6 entries, 중복 없음 등); 실패 시 parser-error 동반해 1회 retry
  3. spec 배열 → `spawnAll(standaloneAdapter)` 진짜 병렬
  4. `synth` agent 가 결과 cross-check 후 최종 답변
- 사전 승인 UI (subtask 목록 + 각 prompt preview) 는 M4.x 로 이연 — 현재는 raw plan 이 그대로 실행됨
- 저장된 워크플로우 (M5): `extensions/ghcp-maestro/saved-workflows/<name>.mjs`

### 4.7 진행상황 / 관리

- `/maestros` 슬래시 → TUI 안에 phase별 agent 수 / token / 시간 표시
- 진행 중 이벤트는 `session.on('tool.execution_complete', ...)` 구독으로 트래킹
- VS Code surface 에서는 별도 TreeView (`workflowProvider`)

### 4.8 권한 / 안전성

- subagent 도구 allowlist 명시 (호출 시점)
- shell / network 기본 차단, 명시 허용 필요
- `onPreToolUse` hook 으로 정책 검증
- 무한 루프 방지: 글로벌 cap + per-phase cap + `onErrorOccurred` retry 한계

### 4.9 비용 / 모델 제어

- `session.setModel()` 로 phase별 모델 override (탐색은 small, 합성은 large)
- 누적 token 추적 (`tool.execution_complete` 이벤트 metadata)
- `/maestro usage` 슬래시로 보고

---

## 5. 품질 패턴 (라이브러리)

스크립트에서 import해서 쓰는 helper:

- `adversarialReview(findings, { reviewers })` — 독립 agent 반박 → 살아남은 것만 반환
- `multiAngle(task, { angles })` — 여러 각도 초안 → 비교 → 채택
- `fixLoop({ build, test, maxIters })` — 클린될 때까지 반복
- `crossCheck(claims, { sources })` — claim별 다중 source 검증

참조 패턴: `spawnAll` 위에 multi-reviewer voting / multi-angle drafting / loop-until-clean — multi-agent quality pattern 의 일반적 형식.

---

## 6. 아키텍처 개요 (M4 기준 실측 반영)

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

VS Code β surface (chat participant + TreeView) 는 Phase 7.

---

## 7. 기술 스택

- Node.js 20+ / ESM
- TypeScript (개발), 빌드 결과는 `.mjs` (CLI extension 제약)
- SDK: `@github/copilot-sdk` (extension + standalone)
- 동시성: `p-queue` 또는 자체 구현
- 영속화: 파일시스템 JSON
- VS Code 부 surface: `vscode` API + `@vscode/chat-extension-utils`

---

## 8. 단계별 마일스톤 (현 진행 상태)

- **M1 — PoC extension** ✅ — `extensions/ghcp-maestro/extension.mjs` 골격, `/maestro hello` 로드 확인
- **M2 — Spawn 런타임** ✅ — zero-deps semaphore + `spawn` / `spawnAll`, dummy adapter, 14 단위 테스트
- **M2.5 — LLM-mediated adapter** ✅ (mismatch 확인, probe 만 유지) — host session turn-bound → fan-out 불가
- **M2.6 — Standalone CopilotClient adapter** ✅ — 진짜 격리 + 병렬 검증
- **M3 — 상태/Resume** ✅ — RunStore 영속화, `/maestros`, `/maestro-resume`, `/maestro-stop`, crash recovery 실측
- **M4 — 메타 프롬프트** ✅ — `/maestro task <자연어>` → plan → explore[N] → synth
- **M4.x — Plan 사전 승인 UI** ❌ — `session.ui.elicitation` 통합 (선택)
- **M5 — 저장된 워크플로우** ✅ — `runtime/saved-workflows.mjs` 스캔(project>user>bundled) + `/maestro run <name>` / `/maestro workflows`, sandboxed `api` (`buildWorkflowApi`), bundled `deep-review` 예제
- **M6 — 품질 helper** ✅ — `runtime/quality.mjs`: `adversarialReview`, `multiAngle`, `fixLoop`, `crossCheck` (`spawnAll` 위, adapter 비종속, 단위 테스트 완비)
- **M7 — VS Code surface** ❌ — 별도 `vscode-extension/` 패키지
- **M8 — Standalone SDK fan-out** ✅ (M2.6 에서 선행 완료)
- **CI / 정적분석** ✅ — ESLint flat config + `.github/workflows/ci.yml` (lint + `node --check` + `node:test`, Node 20/22) + `codeql.yml`

자세한 산출물 / 실측 / acceptance 는 [PLAN.md](PLAN.md) 참고.

---

## 9. 핵심 가치

GHCP CLI 위에서 다음을 한 plugin 으로 통합:

- 자연어 task 자동 분할 (메타 프롬프트)
- 격리된 child Copilot 세션 fan-out (진짜 병렬, concurrency cap 16 / 글로벌 1000)
- 결과 영속화 + 부분 crash recovery (`~/.copilot/plugin-data/ghcp-maestro/`)
- 호스트 세션 context 격리

---

## 10. 열린 질문 (M4 시점 업데이트)

- ✅ **Q1.** Standalone SDK 통합 우선순위 — M2.6 에서 선행 완료 (`standalone-client` adapter)
- **Q2.** 메타 프롬프트 모델 — 현재는 child session 기본 모델 그대로. `setModel('xhigh')` 강제 옵션은 M4.x 검토.
- **Q3.** VS Code surface 우선순위 — M5/M6 후 (현재 GHCP-only 검증 완료)
- ✅ **Q4.** 저장된 워크플로우 슬래시 — 동적 등록 결정 (M5 에서 구현 예정)
- **Q5.** TS → `.mjs` 빌드 — 현재 zero-deps plain `.mjs` 직접 운영 중. M5/M6 에서 helper 라이브러리가 늘어나면 esbuild 도입 재검토.
- ✅ **Q6.** 메모리/Resume 보조 통합 — 직접 구현 (M3 RunStore). 외부 의존 없음.
- **Q7. (신규)** Plan 사전 승인 — subtask 목록 + 각 prompt preview 를 `session.ui.elicitation` 으로 보여줄지 (M4.x).
- **Q8. (신규)** Saved workflow 보안 — 다른 사람이 공유한 `.mjs` 를 신뢰 검증 없이 실행할지, 권한 preview 강제할지 (M5 brainstorm 결과 반영).
