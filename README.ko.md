# ghcp-maestro

[English](README.md) | **한국어**

> GitHub Copilot CLI 를 위한 멀티 에이전트 워크플로우 런타임.

작업을 자연어로 한 줄 던지면, ghcp-maestro 가 그것을 여러 개의 독립적인 하위
작업으로 쪼개고, 각 작업을 **자기만의 격리된 child Copilot 세션에서 진짜로
병렬 실행**한 뒤, 결과를 하나의 답으로 합친다. 별도의 외부 CLI 도, 데몬도,
외부 서비스도 없는 GitHub Copilot CLI 플러그인 하나로 동작한다.

![/maestro task 실행: 계획 → 승인 게이트 → 실시간 대시보드와 함께 병렬 fan-out → 종합된 최종 답변](docs/assets/demo.gif)

<sub>`/maestro task` 실행의 스크립트 리플레이 — 로그 라인은 런타임의 실제
출력을 가깝게 재현한 것으로, GIF 를 위해 색을 입히고 시간을 압축했다.
[`vhs demo/demo.tape`](demo/demo.tape) 로 재생성.</sub>

> ghcp-maestro 는 **orchestrator-workers** 패턴을 GitHub Copilot CLI 로 구현한
> 것이다 — 분해 → 병렬 에이전트 fan-out → 교차 검증 → 하나의 종합 답변, 그리고
> run 을 영속화해 재실행 가능.

---

## 시작하기

ghcp-maestro 는 GitHub Copilot CLI 의 **실험적 extensions** 기능을 사용한다.
따라서 GitHub Copilot CLI ≥ 1.0.65 (Node.js 20+) 와 `--experimental` 플래그가
필요하다.

```bash
# 리포지토리 루트에서 플러그인 설치
copilot plugin install "$(pwd)"     # PowerShell: copilot plugin install (Get-Location)

# 실험적 기능을 켜고 세션 시작
copilot --experimental
```

그 다음, 세션 안에서:

```text
/maestro help
/maestro task REST 에서 GraphQL 로 API 를 옮기는 마이그레이션 계획을 짜줘
```

대화형 환경에서 `/maestro task` 는 fan-out 전에 계획 승인을 요청한다.
`GHCP_MAESTRO_AUTO_APPROVE=1` 을 설정하면 이 프롬프트를 건너뛰고 항상 모든 하위
작업을 실행한다.

---

## 무엇을 할 수 있나

`/maestro task` 는 한 번의 대화로는 벅찬 작업 — 여러 갈래로 나눠 병렬로 조사하고
교차 검증해야 하는 일 — 에서 빛난다. 예시:

**코드베이스 감사** — 한 영역 전체를 한 종류의 문제 기준으로 병렬 점검.
```text
/maestro task src/api 아래 모든 라우트에서 인증/입력 검증 누락을 감사하고, 파일과 수정안과 함께 각 항목을 정리해줘
```

**대규모 마이그레이션/리팩터링 계획** — 막막한 변경을 여러 각도로 분담.
```text
/maestro task REST API 를 GraphQL 로 옮기는 계획: 스키마 설계, 리졸버 구조, 인증, 페이지네이션, 위험요소를 포함한 단계적 롤아웃
```

**교차 검증 리서치** — 독립된 여러 각도에서 모은 뒤 검증을 통과한 것만 남김.
```text
/maestro task 쓰기 많은 멀티테넌트 SaaS 에 PostgreSQL/MySQL/SQLite 를 성능·운영·비용·마이그레이션 부담 기준으로 교차 비교해줘
```

**의사결정/트레이드오프 분석** — 한 결정을 여러 관점에서 동시에 평가.
```text
/maestro task 모노레포 도입 여부를 툴링·CI·코드 공유·팀 워크플로우·마이그레이션 비용 관점에서 평가하고 권고안을 줘
```

**다관점 브레인스토밍** — 모호한 주제를 고정된 관점들로 탐색.
```text
/maestro brainstorm 안정성을 해치지 않으면서 클라우드 비용을 줄이는 방법
```

**반복 워크플로우** — 잘 동작하는 절차를 스크립트로 저장해 자체 명령으로 재실행
(예: 브랜치마다 돌리는 심층 코드 리뷰):
```text
/maestro run deep-review {"topic": "이 브랜치의 diff"}
```

**워크플로우 공유** — 다른 사람의 워크플로우를 GitHub 에서 바로 설치:
```text
/maestro install acme/flows/workflows/security-audit.mjs@v1
```

---

## 명령어

| 명령 | 설명 |
| :-- | :-- |
| `/maestro task <자연어>` | 분할 → (승인) → 병렬 fan-out → 종합 |
| `/maestro brainstorm <주제>` | 다관점 브레인스토밍 → 종합 |
| `/maestro run <이름> [인자]` | 저장된 워크플로우 실행 (`인자`: JSON 객체 또는 평문) |
| `/maestro workflows` | 사용 가능한 저장 워크플로우 목록 |
| `/maestro install <소스> [--force]` | GitHub 에서 저장 워크플로우를 사용자 디렉터리로 설치 |
| `/maestros [runId]` | 최근 run 목록, 또는 한 run 의 실시간 대시보드 |
| `/maestro-resume <runId>` | run 재실행; 캐시된 에이전트는 건너뜀 |
| `/maestro-stop <runId>` | run 중지 + 진행 중 에이전트 abort |
| `/maestro help` | 전체 하위 명령 보기 |

---

## 기능

**작업 자동 분할.**
`/maestro task <자연어>` 는 `plan` 에이전트에게 작업을 3–6 개의 독립적인 하위
작업으로 쪼개게 한다 — 목표만 설명하면 조각은 알아서 나눈다. 계획은 하위 작업
간 `dependsOn` 을 선언할 수 있다: 의존하는 작업은 다음 웨이브에서 의존 대상의
출력이 프롬프트에 주입된 채 실행되고, 의존 대상이 실패하면 무작정 실행하는
대신 건너뛴다.

**격리된 진짜 병렬 fan-out.**
각 하위 작업은 자기만의 child Copilot 세션에서 동시에 실행된다 (기본 16 개
동시, 최대 1000). 호스트 대화는 깨끗하게 유지되고, 하위 작업마다 새 컨텍스트
창을 쓰며, 전체 소요 시간은 하위 작업들의 합이 아니라 가장 느린 하나 정도로
줄어든다. 에이전트별 타임아웃은 기본 10 분 (`GHCP_MAESTRO_TIMEOUT_MS` 로 연장
가능)이고, 일시적 실패(API 오류, rate limit)는 지수 백오프로 자동 재시도한다.

**fan-out 전 사전 승인.**
대화형 환경에서는 계획 수립 후 잠시 멈춰, 하위 작업 목록과 프롬프트 미리보기를
보여준다. 비싼 병렬 작업이 시작되기 전에 전체 승인 · 일부만 선택 · 취소 를
고를 수 있다.

**비용 가시성과 토큰 예산.**
fan-out 전 게이트에 실행 규모 추정이 표시되고, 하위 작업이
`GHCP_MAESTRO_LARGE_RUN_AGENTS` 개 이상(기본 5)이면 경고가 나온다. task
워크플로우의 토큰 집계는 항상 켜져 있다: 워크플로우 스스로 run 을 종료하는
경로(완료 · 예산 soft-stop · 실패)마다 총 토큰 사용량이 run 매니페스트에
기록되어 `/maestros` 에서 run 별 비용을 볼 수 있다 (실행 중인 run 을 밖에서
`/maestro-stop` 하면 최종 합계가 없을 수 있다). 상한 강제는 opt-in —
`GHCP_MAESTRO_BUDGET_TOKENS=<n>` (`500k` / `2m` 축약 가능) 으로 run 상한을
걸면, 상한 도달 시 진행 중 에이전트는 마무리하고, 아직 시작 안 한 에이전트는
건너뛴 뒤 run 을 soft-stop 한다 — 나중에 `/maestro-resume` 으로 이어서 실행.
`/maestros` 는 에이전트별 · 전체 토큰 사용량을 실시간으로 보여준다.

**모델 라우팅 (opt-in).**
기계적인 하위 작업을 처리하는 worker 에이전트가 planner 나 synth 와 같은 모델을
쓸 필요는 거의 없다. `GHCP_MAESTRO_MODEL_ROUTES` 에 라벨 패턴 → 모델 JSON 맵을
설정한다 — 라벨은 `plan`, `explore:<agent>`, `verify`, `synth`; `*` 와일드카드,
첫 매치 우선:

```
GHCP_MAESTRO_MODEL_ROUTES='{"explore:*":"gpt-5-mini","synth":"claude-sonnet-4.5"}'
```

매치되지 않는 라벨(그리고 라우트가 아예 없는 기본 상태)은 child 세션의 기본
모델을 쓴다.

**종합 전 검증 (opt-in).**
`GHCP_MAESTRO_VERIFY=1` 을 설정하면 fan-out 과 종합 사이에 검증 단계가 들어간다:
에이전트 하나가 각 하위 작업 결과를 원래 목표 기준으로 판정하고
(충족 / 부분 충족 / 미충족, 구체적인 결손 포함), 그 보고서가 synth 에이전트에
전달되어 검증 안 된 주장이 확정 사실처럼 제시되지 않게 한다. 기본은 꺼짐 —
run 당 에이전트 하나만큼 비용이 더 든다. 검증 에이전트가 실패해도 run 은
실패하지 않는다; 보고서 없이 종합을 진행한다.

**결과 종합.**
`synth` 에이전트가 모든 하위 작업 결과를 교차 검증해 **최종 답변 + 다음 액션**
으로 합친다. 실패한 하위 작업은 숨기지 않고 공개한다: synth 프롬프트에
`(FAILED: <status>)` 로 표시되고 어떤 관점이 빠졌는지 명시하라는 지시가
붙으며, 최종 출력에 커버리지 라인(`coverage: 4/5 subtasks ok (1 timeout)`)이
포함된다.

**영속화와 재실행.**
모든 run 은 디스크에 저장된다. `/maestro-resume <runId>` 로 다시 실행하면 이미
끝난 에이전트는 캐시에서 가져오고, 누락되거나 실패한 것만 다시 돌린다.

**백그라운드 실행과 모니터링.**
`/maestro task|brainstorm|run` 는 백그라운드로 시작돼, 에이전트가 fan-out 되는
동안 세션은 계속 자유롭다. `/maestros` 로 실행 목록과 진행 요약을, `/maestros
<runId>` 로 에이전트별 상세 대시보드를 본다.

**OTel GenAI 스타일 trace 내보내기.**
종료 상태(complete / stopped / error)에 도달한 모든 run 은 매니페스트 옆에
`trace.json` 을 쓴다: `invoke_workflow` 루트 span 하나 + 에이전트별
`invoke_agent` span, OpenTelemetry GenAI 시맨틱 컨벤션 속성 이름
(`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`,
`gen_ai.usage.total_tokens`, `error.type`) 사용. OTel 스타일 JSON 문서이지
완전한 OTLP 페이로드는 아니다 — 실제 exporter 가 필요하면 후처리할 것.
(업스트림 GenAI 컨벤션은 아직 Development 상태라 속성 이름이 바뀔 수 있다.)

**브레인스토밍.**
`/maestro brainstorm <주제>` 는 여러 관점의 에이전트를 병렬로 펼친 뒤, 관점을
가로질러 종합한다.

**저장된 워크플로우.**
반복되는 다단계 절차를 작은 워크플로우 스크립트로 저장해 `/maestro run <이름>`
으로 실행한다. 스크립트는 샌드박스된 API (`spawn`/`spawnAll`/`phase` 와 품질
helper) 만 사용하며, 파일시스템 · 셸 · SDK 에 직접 접근하지 않는다.

**품질 helper.**
워크플로우 작성자를 위한 멀티 에이전트 패턴: `adversarialReview` (반론 검토),
`multiAngle` (다관점 초안 후 심사), `fixLoop` (검사를 통과할 때까지 수정 반복),
`crossCheck` (여러 출처로 주장 교차 검증).

---

## 설정

모든 튜닝은 환경 변수로 한다 — 가시성 기능은 항상 켜져 있고, 토큰을 추가로
쓰는 것은 전부 opt-in 이다. (진단용 프로브 설정 — `GHCP_MAESTRO_PROBE_*`,
`GHCP_MAESTRO_TIMEOUT_PROBE_MS` — 은 의도적으로 제외.)

| 변수 | 기본값 | 역할 |
| :-- | :-- | :-- |
| `GHCP_MAESTRO_AUTO_APPROVE` | 꺼짐 | 계획 승인 게이트 생략; 항상 모든 하위 작업 실행 |
| `GHCP_MAESTRO_BUDGET_TOKENS` | 무제한 | run 시도당 토큰 상한 (`500k` / `2m` 축약); 도달 시 soft-stop |
| `GHCP_MAESTRO_MODEL_ROUTES` | 없음 | 에이전트 라벨 → 모델 JSON 맵 (`plan`, `explore:<agent>`, `verify`, `synth`; `*` 와일드카드) |
| `GHCP_MAESTRO_VERIFY` | 꺼짐 | fan-out 과 종합 사이에 검증 단계 삽입 (run 당 에이전트 1개 추가) |
| `GHCP_MAESTRO_TIMEOUT_MS` | `600000` (10분) | 에이전트별 타임아웃 |
| `GHCP_MAESTRO_RETRIES` | `1` | 일시적 실패 자동 재시도 횟수 (`0` 이면 비활성) |
| `GHCP_MAESTRO_LARGE_RUN_AGENTS` | `5` | 게이트에서 "large fan-out" 경고를 띄우는 하위 작업 수 |
| `GHCP_MAESTRO_NO_MONITOR` | 꺼짐 | 실시간 진행 추적 끄기 |
| `GHCP_MAESTRO_DATA_DIR` | `~/.copilot/plugin-data/ghcp-maestro` | run 상태(매니페스트, 에이전트 출력, trace) 저장 위치 |
| `GHCP_MAESTRO_WORKFLOWS_DIR` | `<cwd>/.ghcp-maestro/workflows` | 프로젝트 저장 워크플로우 디렉터리 (최우선) |

---

## 알려진 한계

- **`copilot --experimental` 필수.** extensions 표면은 CLI 실험 플래그 뒤에
  있으며, 없으면 플러그인이 로드되지 않음.
- **fan-out 은 비용을 배가.** 모든 서브태스크가 실제 자식 Copilot 세션.
  플랜 게이트의 run-size 추정과 `GHCP_MAESTRO_BUDGET_TOKENS` soft-stop 이
  있지만 지출은 실제 발생. 작게 시작할 것.
- **워크플로우는 코드.** 저장/설치된 워크플로우는 세션 권한으로 실행됨.
  `/maestro install` 은 실행 없이 검증 + 경고하지만, `/maestro run` 전
  파일 리뷰는 사용자 몫.
- **플랜 승인 게이트는 인터랙티브 호스트 전용.** elicitation 미지원 호스트
  (CI, `copilot -p`)는 모든 서브태스크 자동 승인.
- **`/maestro-stop` 의 in-flight abort 는 run 을 시작한 세션에서만 동작.**
  다른 세션에서는 stopped 마킹만 되고, 이미 실행 중인 자식 세션은 자체
  종료까지 진행.
- **`/maestro install` blob URL 은 `/` 포함 ref 미지원** (예: `feature/x`
  브랜치) — raw URL 또는 `owner/repo/path@ref` shorthand 사용.

## 더 알아보기

- [docs/DEMO.md](docs/DEMO.md) — 5분 end-to-end 워크스루
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 제품 비전과 요구사항
- [docs/PLAN.md](docs/PLAN.md) — 마일스톤과 설계 결정
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 릴리스 이력

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
