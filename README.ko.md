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

**반복 워크플로우** — 잘 동작하는 절차를 스크립트로 저장해 자체 명령으로
재실행하거나, 다른 사람의 워크플로우를 GitHub 에서 바로 설치:
```text
/maestro run deep-review {"topic": "이 브랜치의 diff"}
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
| `/maestro-stop <runId>` | run 중지 (run 을 시작한 세션에서 실행 시 진행 중 에이전트 abort) |
| `/maestro help` | 전체 하위 명령 보기 |

---

## 기능 한눈에 보기

- **작업 자동 분할** — `plan` 에이전트가 3–6 개 하위 작업으로 분할, 하위 작업
  간 `dependsOn` 웨이브 지원.
- **격리된 진짜 병렬 fan-out** — 하위 작업마다 자기만의 child Copilot 세션과
  새 컨텍스트 창; 전체 시간 ≈ 가장 느린 하나.
- **사전 승인 게이트** — 비싼 fan-out 시작 전에 계획 검토 · 일부 선택 · 취소.
- **비용 가시성 + opt-in 토큰 예산** — 게이트의 규모 추정, 항상 켜진 토큰 집계,
  `GHCP_MAESTRO_BUDGET_TOKENS` soft-stop.
- **모델 라우팅 (opt-in)** — `GHCP_MAESTRO_MODEL_ROUTES` 로 worker 를 더 싼
  모델에 배정.
- **검증 단계 (opt-in)** — `GHCP_MAESTRO_VERIFY=1` 로 종합 전에 각 하위 작업을
  목표 기준으로 판정.
- **결과 종합** — 교차 검증된 최종 답변, 실패한 하위 작업은 공개
  (`coverage: 4/5 subtasks ok`).
- **영속화 & 재실행** — 모든 run 디스크 저장; `/maestro-resume` 은 빠진 것만
  재실행.
- **백그라운드 실행 + 실시간 대시보드** — 작업하는 동안 `/maestros` 로
  에이전트별 진행과 토큰 사용량 확인.
- **OTel GenAI 스타일 trace 내보내기** — 종료된 run 마다 best-effort
  `trace.json`.
- **저장 워크플로우 & 품질 helper** — 샌드박스 워크플로우 스크립트,
  `adversarialReview` / `multiAngle` / `fixLoop` / `crossCheck`.

기능별 상세 설명과 전체 `GHCP_MAESTRO_*` 환경 변수 레퍼런스는
**[docs/GUIDE.ko.md](docs/GUIDE.ko.md)** 에 있다.

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

- [docs/GUIDE.ko.md](docs/GUIDE.ko.md) — 기능 상세 + 전체 설정 레퍼런스
- [docs/DEMO.md](docs/DEMO.md) — 5분 end-to-end 워크스루
- [docs/SURFACES.md](docs/SURFACES.md) — CLI vs. VS Code 설치 표면과 공유 코어
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 제품 비전과 요구사항
- [docs/PLAN.md](docs/PLAN.md) — 마일스톤과 설계 결정
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 릴리스 이력

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
