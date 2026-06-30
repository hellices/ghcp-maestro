# ghcp-maestro

[English](README.md) | **한국어**

> GitHub Copilot CLI 를 위한 멀티 에이전트 워크플로우 런타임.

작업을 자연어로 한 줄 던지면, ghcp-maestro 가 그것을 여러 개의 독립적인 하위
작업으로 쪼개고, 각 작업을 **자기만의 격리된 child Copilot 세션에서 진짜로
병렬 실행**한 뒤, 결과를 하나의 답으로 합친다. 별도의 외부 CLI 도, 데몬도,
외부 서비스도 없는 GitHub Copilot CLI 플러그인 하나로 동작한다.

```text
/maestro task 우리 인증 모듈을 JWT 로 옮길 때의 트레이드오프를 분석해줘
```

---

## 기능

**작업 자동 분할.**
`/maestro task <자연어>` 는 `plan` 에이전트에게 작업을 3–6 개의 독립적인 하위
작업으로 쪼개게 한다 — 목표만 설명하면 조각은 알아서 나눈다.

**격리된 진짜 병렬 fan-out.**
각 하위 작업은 자기만의 child Copilot 세션에서 동시에 실행된다 (기본 16 개
동시, 최대 1000). 호스트 대화는 깨끗하게 유지되고, 하위 작업마다 새 컨텍스트
창을 쓰며, 전체 소요 시간은 하위 작업들의 합이 아니라 가장 느린 하나 정도로
줄어든다.

**결과 종합.**
`synth` 에이전트가 모든 하위 작업 결과를 교차 검증해 **최종 답변 + 다음 액션**
으로 합친다.

**fan-out 전 사전 승인.**
대화형 환경에서는 계획 수립 후 잠시 멈춰, 하위 작업 목록과 프롬프트 미리보기를
보여준다. 비싼 병렬 작업이 시작되기 전에 전체 승인 · 일부만 선택 · 취소 를
고를 수 있다.

**영속화와 재실행.**
모든 run 은 디스크에 저장된다. `/maestro-resume <runId>` 로 다시 실행하면 이미
끝난 에이전트는 캐시에서 가져오고, 누락되거나 실패한 것만 다시 돌린다.

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

> ghcp-maestro 는 **orchestrator-workers** 패턴을 GitHub Copilot CLI 로 구현한
> 것이다 — Claude Code 의 *dynamic workflows* 와 같은 아이디어: 분해 → 병렬
> 에이전트 fan-out → 교차 검증 → 하나의 종합 답변, 그리고 run 을 영속화해 재실행
> 가능.

---

## 명령어

| 명령 | 설명 |
| :-- | :-- |
| `/maestro task <자연어>` | 분할 → (승인) → 병렬 fan-out → 종합 |
| `/maestro brainstorm <주제>` | 다관점 브레인스토밍 → 종합 |
| `/maestro run <이름> [인자]` | 저장된 워크플로우 실행 (`인자`: JSON 객체 또는 평문) |
| `/maestro workflows` | 사용 가능한 저장 워크플로우 목록 |
| `/maestros` | 최근 run 목록 (최신순) |
| `/maestro-resume <runId>` | run 재실행; 캐시된 에이전트는 건너뜀 |
| `/maestro-stop <runId>` | run 을 중지로 표시 |
| `/maestro help` | 전체 하위 명령 보기 |

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

## 더 알아보기

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 제품 비전과 요구사항
- [docs/PLAN.md](docs/PLAN.md) — 마일스톤과 설계 결정
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 릴리스 이력

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
