# AGENTS.md — ghcp-maestro

Shared guide for working in this repo from the GHCP CLI / VS Code Copilot Chat.
Spec: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md); execution steps:
[docs/PLAN.md](docs/PLAN.md).

---

## Project in one line

A GitHub Copilot CLI multi-agent workflow runtime. A single plugin that
auto-decomposes a natural-language task, fans out isolated child Copilot
sessions, and adds persistence/resume.
Main surface: `extensions/ghcp-maestro/extension.mjs` (`@github/copilot-sdk/extension`
`joinSession`).
Plugin manifest: `plugin.json` (repo root).

## Hard rules

- Runtime output goes through `session.log()` only — never `console.*` or direct
  stdout (it breaks JSON-RPC).
- ESM only — the extension `package.json` sets `"type": "module"`; build artifacts
  are `.mjs`.
- Slash command prefix `maestro` (e.g. `/maestro`, `/maestros`, `/maestro-resume`);
  tool name prefix `ghcp_maestro_*`.
- Workflow scripts use only the injected global API — no direct FS / shell calls.
- Concurrency: global cap 1000 agents/run, default 16.
- Before adding a new dependency, check whether it can be done zero-deps first.
- When guiding users, state that `copilot --experimental` is required (the
  EXTENSIONS feature flag is experimental).

## Workflow (recommended skill per step)

When starting new work, invoke skills in this order.

1. Spec analysis / design → `brainstorming`
2. Write a plan → `writing-plans` (follow the `PLAN.md` pattern)
3. Multiple independent investigation / implementation →
   `dispatching-parallel-agents` or `subagent-driven-development`
4. Execute the plan → `executing-plans`
5. Tests before implementation → `test-driven-development`
6. Bugs / unexpected behavior → `systematic-debugging` (hypotheses, not guesses)
7. Before claiming completion → `verification-before-completion` (confirm tests/
   build actually pass)
8. Just before merge / PR → `requesting-code-review` → on feedback,
   `receiving-code-review`
9. Wrapping up a branch → `finishing-a-development-branch`

## Domain reference skills

- `@github/copilot-sdk` (`joinSession`, `session.*`, `customAgents`, hooks, tools)
  → `copilot-sdk`
- Meta-prompt (M4) safety review → `ai-prompt-engineering-safety-review`
- Writing a new skill → `writing-skills`

## In-session response style

In-session Korean responses should be short and noun-centric. Avoid unnecessary
particles and translationese. Prose is the exception only where it is genuinely
needed (commit message bodies, release notes, etc.).

## Environment notes

- Node.js 20+; Windows PowerShell 5.1 environment.

## Current status

Phase 6 / **M6 release** plus **M4.x** are done. On top of the M4 task workflow
(plan → fan-out[N] → synth):
- **M5 saved workflows** — `runtime/saved-workflows.mjs` discovery
  (project > user > bundled) + `/maestro run <name>` / `/maestro workflows`,
  sandboxed `api` (`buildWorkflowApi`), bundled `deep-review` example.
- **M6 quality helpers** — `runtime/quality.mjs`: `adversarialReview` /
  `multiAngle` / `fixLoop` / `crossCheck` (on top of `spawnAll`, adapter-agnostic).
- **M4.x plan pre-approval gate** — `runtime/plan-approval.mjs`: review the
  decomposed subtasks and approve / subset / abort before fan-out, gated on
  `session.capabilities.ui.elicitation` with auto-approve fallbacks.
- **Plan logic extracted** — `runtime/plan.mjs` (importable, pure functions).
- **CI / static analysis** — ESLint flat config + `.github/workflows/ci.yml`
  (lint + `node --check` + `node:test`, Node 20/22) + `codeql.yml`. 77 unit tests.

The runtime is still zero-deps (eslint and friends are devDependencies only).

Next: (optional) M7 VS Code surface, and real-time in-TUI run monitoring (tracked
as a separate issue).
