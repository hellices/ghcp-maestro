# 기능 가이드 & 설정

[English](GUIDE.md) | **한국어**

ghcp-maestro 가 하는 일과 모든 설정을 다루는 상세 문서.
간결한 개요는 [README](../README.ko.md), 실습 워크스루는 [DEMO.md](DEMO.md) 참조.

---

## 기능 상세

### 작업 자동 분할

`/maestro task <자연어>` 는 `plan` 에이전트에게 작업을 3–16 개의 독립적인 하위
작업으로 쪼개게 한다 — 목표만 설명하면 조각은 알아서 나눈다. 계획은 하위 작업
간 `dependsOn` 을 선언할 수 있다: 의존하는 작업은 다음 웨이브에서 의존 대상의
출력이 프롬프트에 주입된 채 실행되고, 의존 대상이 실패하면 무작정 실행하는
대신 건너뛴다.

`--agents` 가 없으면 planner 가 작업에 필요한 작업자 수를 스스로 고른다.
`--agents N` 은 총 작업자 수를 정하고, `--concurrency N` 은 그중 동시에
실행할 수를 제한한다.

예시:

```text
/maestro task Audit every API route
/maestro task --agents 12 Audit every package independently
/maestro task --agents 30 --concurrency 8 Migrate each independent module
```

### `@file` 참조 — 마크다운 스펙으로 run 구동

채팅 한 줄에 담기엔 상세한 요청은 마크다운 파일로 쓰고 `@` 로 참조한다:

```text
/maestro task @docs/refactor-spec.md API 레이어부터 우선 진행
```

호스트가 run 시작 **전에** 각 `@경로`(현재 디렉터리 기준, 절대 경로도 가능)를
읽어 파일명과
함께 펜스 처리해 계획 프롬프트와 모든 하위 작업 프롬프트에 인라인한다.
격리된 자식 세션이 파일을 다시 찾을 필요 없이 전체 스펙을 본다. 남은 한 줄
텍스트는 트리거이자 방향 지시, 스펙이 정확성을 담보한다.

규칙과 한도:

- run 당 최대 4개 파일; 파일당 본문 16,000자 (초과분은 잘리고 짧은 잘림 마커가
  덧붙음). 합계 한도 48,000자는 마커 길이 *포함*이라, 여러 파일이 잘리면
  3 × 16,000 보다 약간 일찍 걸릴 수 있다.
- 파일이 없거나 읽을 수 없으면 즉시 중단 — 토큰 소비 전.
- `/maestro brainstorm` 도 같은 방식으로 `@file` 참조 지원.
- run 매니페스트는 원본 라인을 보존하므로 `/maestro-resume` 은 파일을 다시
  읽는다 (스펙 파일이 사라졌으면 깔끔하게 실패). 상대 경로는 resume 하는
  디렉터리 기준으로 해석되므로 같은 파일을 보려면 같은 디렉터리에서 resume
  할 것.
- 모든 하위 작업 프롬프트가 스펙을 포함하므로 큰 스펙 × 넓은 fan-out 은
  토큰 비용을 배가시킨다. (게이트의 low/medium/high 추정은 에이전트 수
  기준이며 프롬프트 크기는 반영되지 않는다 — 스펙 크기는 직접 감안할 것.)
- 참조한 파일 내용은 모든 프롬프트에 담겨 모델로 전송된다 — 시크릿, 자격
  증명 등 민감한 데이터가 든 파일은 절대 참조하지 말 것.

### 격리된 진짜 병렬 fan-out

각 하위 작업은 자기만의 child Copilot 세션에서 동시에 실행된다 (기본 16 개
동시, 최대 1000). 호스트 대화는 깨끗하게 유지되고, 하위 작업마다 새 컨텍스트
창을 쓰며, 전체 소요 시간은 하위 작업들의 합이 아니라 가장 느린 하나 정도로
줄어든다. 에이전트별 타임아웃은 기본 10 분 (`GHCP_MAESTRO_TIMEOUT_MS` 로 연장
가능)이고, 일시적 실패(API 오류, rate limit)는 지수 백오프로 자동 재시도한다.

### 쓰기 모드 — worktree-per-agent 격리 (opt-in)

기본값은 모든 에이전트가 작업 디렉터리에 읽기 전용으로 동작 — 리서치, 리뷰,
감사에 안전하다. 마이그레이션 스윕, 일괄 리팩토링, 테스트 생성처럼 저장소를
수정하는 작업에는 `--write` 를 붙인다:

```text
/maestro task --write legacy restClient 호출 전부를 graphqlClient로 마이그레이션
```

달라지는 것:

- **분리된 파일 스코프.** plan 에이전트가 하위 작업별 수정 파일을 선언해야
  하고, 두 하위 작업이 같은 파일(또는 다른 작업의 파일을 포함하는 디렉터리)을
  가질 수 없다. 겹치면 거부되고 planner가 재시도한다.
- **에이전트별 worktree.** 하위 작업마다 전용 `git worktree` 와 새 브랜치
  `maestro/<runId>/<agent>` (run 데이터 디렉터리 아래)를 받고, 프롬프트가
  그곳에 고정된다: 그 디렉터리에서만 작업, 선언한 스코프만 수정, 결과는 커밋.
- **순차 통합.** fan-out 후 브랜치를 현재 브랜치로 하나씩 머지한다.
  `GHCP_MAESTRO_CHECK_CMD` (예: `npm test`)를 설정하면 머지마다 검사 실행 —
  git이 감지 못하는 의미 충돌에 대한 유일한 알려진 완화책. 충돌이나 검사
  실패 시 통합을 멈추고 어떤 브랜치가 머지됐고 무엇이 수동 해결로 남았는지
  정확히 보고한다; 강제 정리는 없다.
- **안전장치.** 깨끗한 git 작업 트리(`--allow-dirty` 로 해제)와 체크아웃된
  브랜치 필요; git 저장소 밖에서는 거부 — 전부 토큰 소비 전에 검사.
  커밋 안 된 작업이 있는 worktree는 절대 제거하지 않는다.

알려진 한계 (이 분야 모든 도구 공통): lockfile 과 생성 파일은 흔한 충돌
원인이므로 하위 작업 스코프에서 제외할 것; 머지마다 검사를 통과해도 두 변경이
의미적으로 결합됨을 보장하지는 않는다. 통합 결과는 사람 PR 처럼 리뷰할 것.

### fan-out 전 사전 승인

대화형 환경에서는 계획 수립 후 잠시 멈춰, 하위 작업 목록과 프롬프트 미리보기를
보여준다. 비싼 병렬 작업이 시작되기 전에 전체 승인 · 일부만 선택 · 취소 를
고를 수 있다.

### 실행 중간 phase 게이트 (opt-in)

`GHCP_MAESTRO_PHASE_GATE=1` 을 설정하면 fan-out 완료 후 — 다음 지출(쓰기 모드
통합 · verify · synth) 전에 — 한 번 더 멈춘다. 에이전트별 상태와 출력
미리보기를 보여주고 계속할지 묻는다. 거절해도 잃는 것은 없다: 완료된 출력은
캐시되어 있고 `/maestro-resume` 이 그대로 재생해 run 을 마무리한다(재개 시
게이트는 자동 승인). 쓰기 모드에서는 게이트가 브랜치 머지 **이전** 에 있어,
에이전트 결과를 검토하고 저장소를 건드리지 않은 채 멈출 수 있다. 기본은 꺼짐;
elicitation 을 지원하는 환경에서만 대화가 뜨고, 비대화형 환경은 자동으로
계속한다.

### 비용 가시성과 토큰 예산

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

### 모델 라우팅 (opt-in)

기계적인 하위 작업을 처리하는 worker 에이전트가 planner 나 synth 와 같은 모델을
쓸 필요는 거의 없다. `GHCP_MAESTRO_MODEL_ROUTES` 에 라벨 패턴 → 모델 JSON 맵을
설정한다 — 라벨은 `plan`, `explore:<agent>`, `verify`, `synth`; `*` 와일드카드,
첫 매치 우선:

```
GHCP_MAESTRO_MODEL_ROUTES='{"explore:*":"gpt-5-mini","synth":"claude-sonnet-4.5"}'
```

매치되지 않는 라벨(그리고 라우트가 아예 없는 기본 상태)은 child 세션의 기본
모델을 쓴다.

### 종합 전 검증 (opt-in)

`GHCP_MAESTRO_VERIFY=1` 을 설정하면 fan-out 과 종합 사이에 검증 단계가 들어간다:
에이전트 하나가 각 하위 작업 결과를 원래 목표 기준으로 판정하고
(충족 / 부분 충족 / 미충족, 구체적인 결손 포함), 그 보고서가 synth 에이전트에
전달되어 검증 안 된 주장이 확정 사실처럼 제시되지 않게 한다. 기본은 꺼짐 —
run 당 에이전트 하나만큼 비용이 더 든다. 검증 에이전트가 실패해도 run 은
실패하지 않는다; 보고서 없이 종합을 진행한다.

### 결과 종합

`synth` 에이전트가 모든 하위 작업 결과를 교차 검증해 **최종 답변 + 다음 액션**
으로 합친다. 실패한 하위 작업은 숨기지 않고 공개한다: synth 프롬프트에
`(FAILED: <status>)` 로 표시되고 어떤 관점이 빠졌는지 명시하라는 지시가
붙으며, 최종 출력에 커버리지 라인(`coverage: 4/5 subtasks ok (1 timeout)`)이
포함된다.

### 영속화와 재실행

모든 run 은 디스크에 저장된다. `/maestro-resume <runId>` 로 다시 실행하면 이미
끝난 에이전트는 캐시에서 가져오고, 누락되거나 실패한 것만 다시 돌린다.

### 백그라운드 실행과 모니터링

`/maestro task|brainstorm|run` 는 백그라운드로 시작돼, 에이전트가 fan-out 되는
동안 세션은 계속 자유롭다. `/maestros` 로 실행 목록과 진행 요약을, `/maestros
<runId>` 로 에이전트별 상세 대시보드를 본다.

### 라이브 TUI 모니터 (`maestro-top`)

Copilot 세션 밖에서 실시간 뷰가 필요하면 별도 터미널에서 독립 뷰어 실행:

```sh
node extensions/ghcp-maestro/bin/maestro-top.mjs            # 최신 활성 run 팔로우
node extensions/ghcp-maestro/bin/maestro-top.mjs <runId>    # 특정 run 팔로우
node extensions/ghcp-maestro/bin/maestro-top.mjs --all      # 최근 run 목록 1회 출력
```

run 저장소(`GHCP_MAESTRO_DATA_DIR`)를 읽어 1초마다 갱신: 에이전트별 상태 글리프,
경과 시간, 출력 바이트, 현재 도구, 토큰 수. 키: `↑`/`↓`(`k`/`j`) 선택,
`→`/`enter` 이벤트 로그 펼치기, `←` 접기, `a` 전체 펼치기, `s` 선택 에이전트
중지 요청, `q` 종료. 중지는 협조적 방식 — 뷰어가 run의 `control/` 디렉터리에
요청 파일을 쓰면 런타임 폴러(~1초)가 해당 에이전트만 abort하고, 나머지 fan-out은
계속 실행되며 중지된 에이전트는 결과에 `aborted` 로 표시된다.
`GHCP_MAESTRO_TUI=1` 설정 시 백그라운드 실행 힌트에 run별 `maestro-top` 명령이
함께 출력된다. 비-TTY 파이프에서는 변경된 프레임만 append 출력으로 동작.

### OTel GenAI 스타일 trace 내보내기

종료 상태(complete / stopped / error)에 도달한 모든 run 은 매니페스트 옆에
`trace.json` 을 쓴다 (best-effort — IO 실패는 run 을 실패시키지 않고
넘어간다): `invoke_workflow` 루트 span 하나 + 에이전트별
`invoke_agent` span, OpenTelemetry GenAI 시맨틱 컨벤션 속성 이름
(`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`,
`gen_ai.usage.total_tokens`, `error.type`) 사용. OTel 스타일 JSON 문서이지
완전한 OTLP 페이로드는 아니다 — 실제 exporter 가 필요하면 후처리할 것.
(업스트림 GenAI 컨벤션은 아직 Development 상태라 속성 이름이 바뀔 수 있다.)

### 브레인스토밍

`/maestro brainstorm <주제>` 는 여러 관점의 에이전트를 병렬로 펼친 뒤, 관점을
가로질러 종합한다.

### 저장된 워크플로우

반복되는 다단계 절차를 작은 워크플로우 스크립트로 저장해 `/maestro run <이름>`
으로 실행한다. 스크립트는 샌드박스된 API (`spawn`/`spawnAll`/`phase` 와 품질
helper) 만 사용하며, 파일시스템 · 셸 · SDK 에 직접 접근하지 않는다.
`/maestro install <owner>/<repo>/<path>[@ref]` 는 GitHub 의 워크플로우 파일을
사용자 워크플로우 디렉터리로 바로 설치한다 — 실행 없이 검증하고, 워크플로우가
세션 권한으로 실행됨을 경고한다.

`/maestro compose <설명>` 은 스크립트를 대신 작성한다: planner 에이전트가
workflow-api 레퍼런스와 설명을 받아 모듈을 생성한다. 결과는 정적 검증 (파싱 +
주입된 `api` 밖으로 나가는 코드 — import · `process` · `fetch` · `eval` 등 —
차단 스캔) 을 거쳐 사용자 검토에 표시되고, 승인 후에만 토큰을 쓰지 않는 echo
어댑터로 dry-run 한 뒤 프로젝트 워크플로우 디렉터리에 저장된다. `--name
<kebab>` 으로 이름 지정, `--force` 로 덮어쓰기. 비대화형 호스트에서는 아무것도
실행 · 저장하지 않고 `.draft` 파일로만 남긴다.

### 품질 helper

워크플로우 작성자를 위한 멀티 에이전트 패턴: `adversarialReview` (반론 검토),
`multiAngle` (다관점 초안 후 심사), `fixLoop` (검사를 통과할 때까지 수정 반복),
`crossCheck` (여러 출처로 주장 교차 검증).

`fixLoop` 는 명시적 수렴 기준도 받는다: `until` 술어 (외부에서 검증 가능한
조건 — 예: PASS 를 답해야 하는 검증 에이전트 — 로, check 의 ok 대신 종료
조건이 된다) 와 `stallRounds` (check 리포트가 변하지 않는 라운드가 N 회
연속되면 중단). 결과에는 `stopReason` (`converged` / `stalled` / `max-iters`)
과 마지막 `evidence` 문자열이 담겨 루프가 멈춘 이유를 최종 답변에 인용할 수
있다.

---

## 설정

모든 튜닝은 환경 변수로 한다 — 가시성 기능은 항상 켜져 있고, 토큰을 추가로
쓰는 것은 전부 opt-in 이다. (진단용 프로브 설정 — `GHCP_MAESTRO_PROBE_*`,
`GHCP_MAESTRO_TIMEOUT_PROBE_MS` — 은 의도적으로 제외.)

| 변수 | 기본값 | 역할 |
| :-- | :-- | :-- |
| `GHCP_MAESTRO_AUTO_APPROVE` | 꺼짐 | 계획 승인 게이트 생략; 항상 모든 하위 작업 실행 |
| `GHCP_MAESTRO_PHASE_GATE` | 꺼짐 | fan-out 완료 후(통합/verify/synth 전) 멈춰 에이전트 출력 검토 |
| `GHCP_MAESTRO_BUDGET_TOKENS` | 무제한 | run 시도당 토큰 상한 (`500k` / `2m` 축약); 도달 시 soft-stop |
| `GHCP_MAESTRO_MODEL_ROUTES` | 없음 | 에이전트 라벨 → 모델 JSON 맵 (`plan`, `explore:<agent>`, `verify`, `synth`; `*` 와일드카드) |
| `GHCP_MAESTRO_VERIFY` | 꺼짐 | fan-out 과 종합 사이에 검증 단계 삽입 (run 당 에이전트 1개 추가) |
| `GHCP_MAESTRO_CHECK_CMD` | 꺼짐 | 쓰기 모드: 브랜치 머지마다 실행할 셸 명령 (예: `npm test`); 실패 시 통합 중단 |
| `GHCP_MAESTRO_TIMEOUT_MS` | `600000` (10분) | 에이전트별 타임아웃 |
| `GHCP_MAESTRO_RETRIES` | `1` | 일시적 실패 자동 재시도 횟수 (`0` 이면 비활성) |
| `GHCP_MAESTRO_LARGE_RUN_AGENTS` | `5` | 게이트에서 "large fan-out" 경고를 띄우는 하위 작업 수 |
| `GHCP_MAESTRO_NO_MONITOR` | 꺼짐 | 실시간 진행 추적 끄기 |
| `GHCP_MAESTRO_TUI` | 꺼짐 | 백그라운드 실행 힌트에 `maestro-top` 라이브 뷰어 명령 출력 |
| `GHCP_MAESTRO_DATA_DIR` | `~/.copilot/plugin-data/ghcp-maestro` | run 상태(매니페스트, 에이전트 출력, trace) 저장 위치 |
| `GHCP_MAESTRO_WORKFLOWS_DIR` | `<cwd>/.ghcp-maestro/workflows` | 프로젝트 저장 워크플로우 디렉터리 (최우선) |
