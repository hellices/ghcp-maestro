# ghcp-maestro

[English](README.md) | **한국어**

> GitHub Copilot CLI 멀티 에이전트 워크플로우 런타임.

자연어 태스크 한 줄 입력 → 독립 서브태스크로 자동 분해 → 서브태스크별
**격리된 child Copilot 세션에서 실제 병렬 실행** → 단일 답변으로 종합.
외부 CLI · 데몬 · 외부 서비스 없이 GitHub Copilot CLI 플러그인 단독 동작.

![/maestro task 실행: 계획 → 승인 게이트 → 실시간 대시보드와 함께 병렬 fan-out → 종합된 최종 답변](docs/assets/demo.gif)

<sub>`/maestro task` 실행의 스크립트 리플레이 — 로그 라인은 런타임 실제 출력
기반 재현, GIF 용 색상/시간 압축 적용. [`vhs demo/demo.tape`](demo/demo.tape)
로 재생성 가능.</sub>

> **orchestrator-workers** 패턴의 GitHub Copilot CLI 구현 — 분해 → 병렬
> 에이전트 fan-out → 교차 검증 → 단일 종합 답변, run 영속화 및 재실행 지원.

---

## 시작하기

GitHub Copilot CLI 의 **실험적 extensions** 기능 기반. 요구사항:
GitHub Copilot CLI ≥ 1.0.65 (Node.js 20+), `--experimental` 플래그.

```bash
# 리포지토리 루트에서 플러그인 설치
copilot plugin install "$(pwd)"     # PowerShell: copilot plugin install (Get-Location)

# 실험적 기능 활성화 후 세션 시작
copilot --experimental
```

세션 내 실행:

```text
/maestro help
/maestro task REST 에서 GraphQL 로 API 를 옮기는 마이그레이션 계획을 짜줘
```

대화형 환경에서 `/maestro task` 는 fan-out 전 계획 승인 프롬프트 표시.
`GHCP_MAESTRO_AUTO_APPROVE=1` 설정 시 프롬프트 생략, 전체 서브태스크 자동 실행.

---

## 주요 사용 사례

`/maestro task` 적합 영역: 단일 대화로 처리하기 어려운 작업 — 병렬 조사와
교차 검증이 필요한 태스크. 예시:

**코드베이스 감사** — 특정 영역 전체를 단일 문제 유형 기준으로 병렬 점검.
```text
/maestro task src/api 아래 모든 라우트에서 인증/입력 검증 누락을 감사하고, 파일과 수정안과 함께 각 항목을 정리해줘
```

**교차 검증 리서치** — 독립 관점별 수집 후 검증 통과 결과만 채택.
```text
/maestro task 쓰기 많은 멀티테넌트 SaaS 에 PostgreSQL/MySQL/SQLite 를 성능·운영·비용·마이그레이션 부담 기준으로 교차 비교해줘
```

**의사결정/트레이드오프 분석** — 단일 결정을 다관점 동시 평가.
```text
/maestro task 모노레포 도입 여부를 툴링·CI·코드 공유·팀 워크플로우·마이그레이션 비용 관점에서 평가하고 권고안을 줘
```

**다관점 브레인스토밍** — 모호한 주제를 고정 관점 세트로 탐색.
```text
/maestro brainstorm 안정성을 해치지 않으면서 클라우드 비용을 줄이는 방법
```

**반복 워크플로우** — 검증된 절차를 스크립트로 저장해 자체 명령으로 재실행,
또는 외부 워크플로우를 GitHub 에서 직접 설치:
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
| `/maestro help` | 전체 하위 명령 목록 |

---

## 기능 한눈에 보기

- **작업 자동 분할** — `plan` 에이전트가 3–6 개 서브태스크로 분할, 서브태스크
  간 `dependsOn` 웨이브 지원.
- **격리된 실제 병렬 fan-out** — 서브태스크별 전용 child Copilot 세션과
  독립 컨텍스트 창; 전체 소요 시간 ≈ 최장 서브태스크.
- **사전 승인 게이트** — 고비용 fan-out 실행 전 계획 검토 · 부분 선택 · 취소.
- **비용 가시성 + opt-in 토큰 예산** — 게이트의 규모 추정, 상시 토큰 집계,
  `GHCP_MAESTRO_BUDGET_TOKENS` soft-stop.
- **모델 라우팅 (opt-in)** — `GHCP_MAESTRO_MODEL_ROUTES` 로 worker 를 저비용
  모델에 배정.
- **검증 단계 (opt-in)** — `GHCP_MAESTRO_VERIFY=1` 설정 시 종합 전 서브태스크별
  목표 기준 판정.
- **결과 종합** — 교차 검증된 최종 답변, 실패 서브태스크 명시
  (`coverage: 4/5 subtasks ok`).
- **영속화 & 재실행** — 전체 run 디스크 저장; `/maestro-resume` 은 미완료분만
  재실행.
- **백그라운드 실행 + 실시간 대시보드** — 작업 중 `/maestros` 로 에이전트별
  진행 상황과 토큰 사용량 확인.
- **OTel GenAI 스타일 trace 내보내기** — 종료된 run 마다 best-effort
  `trace.json`.
- **저장 워크플로우 & 품질 helper** — 샌드박스 워크플로우 스크립트,
  `adversarialReview` / `multiAngle` / `fixLoop` / `crossCheck`.

기능별 상세 설명과 전체 `GHCP_MAESTRO_*` 환경 변수 레퍼런스:
**[docs/GUIDE.ko.md](docs/GUIDE.ko.md)** 참조.

---

## 알려진 한계

- **`copilot --experimental` 필수.** extensions 표면은 CLI 실험 플래그 뒤에
  위치, 플래그 미지정 시 플러그인 미로드.
- **fan-out 은 비용 배가.** 서브태스크마다 실제 child Copilot 세션 생성.
  플랜 게이트의 run-size 추정과 `GHCP_MAESTRO_BUDGET_TOKENS` soft-stop 제공,
  단 지출은 실제 발생. 소규모 시작 권장.
- **워크플로우는 코드.** 저장/설치된 워크플로우는 세션 권한으로 실행.
  `/maestro install` 은 실행 없이 검증 + 경고만 수행, `/maestro run` 전
  파일 리뷰는 사용자 책임.
- **플랜 승인 게이트는 인터랙티브 호스트 전용.** elicitation 미지원 호스트
  (CI, `copilot -p`)는 모든 서브태스크 자동 승인.
- **`/maestro-stop` 의 in-flight abort 는 run 시작 세션에서만 동작.**
  타 세션에서는 stopped 마킹만 수행, 실행 중인 child 세션은 자체 종료까지
  진행.
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
