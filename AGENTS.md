# AGENTS.md — ghcp-maestro

이 레포 작업 시 GHCP CLI / VS Code Copilot Chat 공통 가이드.
스펙은 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), 실행 단계는 [docs/PLAN.md](docs/PLAN.md).

---

## 프로젝트 한 줄

GitHub Copilot CLI multi-agent workflow runtime. 자연어 task 자동 분할 + 격리된 child Copilot 세션 fan-out + 영속화/resume 통합 plugin.
메인 surface: `extensions/ghcp-maestro/extension.mjs` (`@github/copilot-sdk/extension` `joinSession`).
플러그인 manifest: `plugin.json` (repo root).

## 절대 규칙

- 런타임 출력은 `session.log()` 만 — `console.*` / stdout 직접 금지 (JSON-RPC 깨짐)
- ESM only — extension `package.json` `"type": "module"`, 산출물 `.mjs`
- Slash command prefix `maestro` (예: `/maestro`, `/maestros`, `/maestro-resume`); Tool name prefix `ghcp_maestro_*`
- 스크립트(워크플로우)는 inject된 글로벌 API만 사용 — FS / shell 직접 호출 금지
- 동시성 글로벌 cap 1000 agent/run, 기본 16
- 새 의존성 추가 전 zero-deps 가능 여부 먼저 확인
- 사용자에게 안내 시 `copilot --experimental` 필요함을 명시 (EXTENSIONS feature flag = experimental)

## 워크플로우 (단계별 권장 skill)

새 작업 시작 시 아래 순서로 skill 호출.

1. 스펙 분석 / 설계 → `brainstorming`
2. 계획 작성 → `writing-plans` (`PLAN.md` 패턴 따름)
3. 다중 독립 조사 / 구현 → `dispatching-parallel-agents` 또는 `subagent-driven-development`
4. 계획 실행 → `executing-plans`
5. 구현 전 테스트 → `test-driven-development`
6. 버그 / 예상 외 동작 → `systematic-debugging` (가설 → 추측 금지)
7. 완료 주장 전 → `verification-before-completion` (테스트/빌드 실제 통과 확인)
8. 머지 / PR 직전 → `requesting-code-review` → 피드백 받으면 `receiving-code-review`
9. 브랜치 마무리 → `finishing-a-development-branch`

## 도메인별 참조 skill

- `@github/copilot-sdk` (`joinSession`, `session.*`, `customAgents`, hooks, tools) → `copilot-sdk`
- 메타 프롬프트 (M4) 안전성 검토 → `ai-prompt-engineering-safety-review`
- 새 skill 작성 시 → `writing-skills`

## 한국어 응답 스타일

세션 내 한국어 응답은 짧고 명사형 중심. 불필요한 조사/번역체 금지.
긴 산문 필요한 경우만 예외 (커밋 메시지 본문, 릴리스 노트 등).

## 환경 메모

- Node.js 20+, Windows PowerShell 5.1 환경

## 현 단계

Phase 4 / **M4 release** 완료. `/maestro task <자연어>` 가 plan agent (LLM 분할) → 격리된 N child Copilot session 병렬 → synth 종합까지 end-to-end 동작. `/maestro help` UX, plan parser 견고화, 31 단위 테스트, CHANGELOG 정리 완료.

다음은 (선택) M4.x plan 사전 승인 UI, M5 saved workflows, M6 quality helpers, M7 VS Code surface.
