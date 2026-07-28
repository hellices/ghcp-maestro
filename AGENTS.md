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
`joinSession`). Shared runtime kernel: `core/*` (the `@ghcp-maestro/core` package,
imported by both the CLI plugin and `vscode-extension/`).
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
- Test style: assert human-readable log/dashboard lines with `assert.match` on
  the key tokens (status, ids, counts), not full-string equality — except where
  the byte shape itself is the contract (LLM prompt inputs like `agentDigest`,
  cross-surface parity outputs like the synth prompt).
- When guiding users, state that `copilot --experimental` is required (the
  EXTENSIONS feature flag is experimental).

## Development commands

```sh
npm install                        # dev tooling only (runtime is zero-deps)
npm run lint                       # eslint flat config
npm run lint:fix                   # eslint --fix
npm test                           # node --test tests/*.test.mjs
node --test tests/<name>.test.mjs  # single test file while iterating
npm run check                      # lint + test (the full local gate)
```

## Workflow economics

- While iterating, run only **targeted** checks (the single test file you
  touched, lint on changed files). CI covers the full matrix (Node 20/22).
- Run `npm run check` once before every commit — never commit with a red gate,
  and never weaken a test or lint rule to make a failure pass.
- Commit frequently in small, coherent steps.

## Architecture — layer rules

```
core/                     # surface-agnostic kernel (@ghcp-maestro/core), zero-deps
├── adapters/             # agent adapters (llm-mediated, reply-text, standalone-client)
extensions/ghcp-maestro/  # CLI plugin composition root (extension.mjs)
vscode-extension/         # VS Code surface (chat participant, tree view, console panel)
tests/                    # node:test suites for all of the above
```

| Layer | May import | Notes |
|---|---|---|
| `core/` | Node stdlib only | No `vscode`, no static `@github/copilot-sdk`. The only SDK touchpoint is the **dynamic** import inside `core/adapters/standalone-client.mjs`. |
| `extensions/ghcp-maestro/` | core, `@github/copilot-sdk/extension` | Thin composition root — wiring only, logic lives in core. |
| `vscode-extension/` | core, `vscode` | `import "vscode"` only in `vscode-extension/extension.mjs`; every other module receives `vscode` (or a port) via constructor/parameter injection. |
| `tests/` | everything | Fakes (`session`, `ui`, adapters) instead of real hosts. |

- New shared behaviour goes in `core/` first; both surfaces consume it — never
  duplicate logic between `extension.mjs` and `runtime-bridge.mjs`.
- Dependencies are passed explicitly (function params / factory options). No
  globals, no service locators.

## Docs layout

- Design specs and implementation plans live in `docs/specs/` as
  `YYYY-MM-DD-<topic>-design.md` / `...-plan.md`. (This overrides any skill
  default such as `docs/superpowers/…`.)
- `docs/CHANGELOG.md` follows Keep a Changelog; land user-visible changes under
  `Unreleased` in the same PR.
- Release/versioning procedure: `docs/RELEASING.md` (version is kept in sync in
  4 files — bump together).

## Commits

- Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `release:`) — match
  the existing history.
- Run `npm run check` on the final state before committing.

## Pull requests

- Do NOT open a pull request without explicit human instruction.
- Work on a branch; merge via PR with CI green (lint + `node --check` +
  `node:test` on Node 20/22, CodeQL).
- Request a Copilot review before asking for a human one.

## Review loop

For each review round on a PR:

1. Read every comment, including suppressed low-confidence ones in the review
   body's `<details>` block. Classify by confidence and impact; suppressed
   low-confidence findings are advisory, not automatically mandatory.
2. Always address credible correctness, security, data-loss, or
   architecture-invariant findings. Fix code findings with TDD: failing test
   first (RED), then the fix (GREEN).
3. Run `npm run check` before committing. Never `--amend` pushed commits.
4. Reply to each review comment individually, naming the commit and test:
   `gh api repos/OWNER/REPO/pulls/N/comments/{comment_id}/replies -f body=...`
5. Resolve each addressed thread:
   `gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"PRRT_..."}) { thread { isResolved } } }'`
6. Re-request review:
   `gh api -X POST repos/OWNER/REPO/pulls/N/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`
7. After **2 consecutive rounds** containing only suppressed low-confidence
   findings and no unresolved blocking findings, stop speculative changes and
   proceed toward merge. A new credible blocking finding resets the counter.
   Never use the round limit to ignore a credible blocking finding.
8. Before merging, verify every required check:
   `gh pr view N --json statusCheckRollup` must be all SUCCESS, then
   `gh pr merge N --squash`.

## Testing gotchas

- Suites run with `node:test` — no test framework deps. Fakes over mocks: a
  fake `session` is `{ log: (...) => records.push(...) }`, a fake `ui` records
  elicitation calls; see `tests/plan-approval.test.mjs` for the pattern.
- Async agent behaviour (timeouts, cancellation) is tested with real
  `AbortController`s and promise races — never wall-clock sleeps or timing
  asserts.
- When you add a port method (log/ui/cancellation), update every fake in the
  same change — grep `tests/` for the port name.

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
- **M5 saved workflows** — `core/saved-workflows.mjs` discovery
  (project > user > bundled) + `/maestro run <name>` / `/maestro workflows`,
  sandboxed `api` (`buildWorkflowApi`), bundled `deep-review` example.
- **M6 quality helpers** — `core/quality.mjs`: `adversarialReview` /
  `multiAngle` / `fixLoop` / `crossCheck` (on top of `spawnAll`, adapter-agnostic).
- **M4.x plan pre-approval gate** — `core/plan-approval.mjs`: review the
  decomposed subtasks and approve / subset / abort before fan-out, gated on
  `session.capabilities.ui.elicitation` with auto-approve fallbacks.
- **Plan logic extracted** — `core/plan.mjs` (importable, pure functions).
- **Shared core package** — the surface-agnostic kernel lives in `core/`
  (`@ghcp-maestro/core`), imported symmetrically by the CLI plugin
  (`extensions/ghcp-maestro/extension.mjs`) and `vscode-extension/`. Synth prompt
  (`core/synth.mjs`) and the run-management commands (`core/run-commands.mjs`:
  `showRuns` / `resumeRun` / `stopRun`) are shared, so both surfaces stay in
  lock-step and `extension.mjs` is a thin composition root.
- **CI / static analysis** — ESLint flat config + `.github/workflows/ci.yml`
  (lint + `node --check` + `node:test`, Node 20/22) + `codeql.yml`. 260+ unit tests.
- **M7 VS Code surface** — `vscode-extension/` chat participant + runs TreeView +
  console panel over the shared core (`runtime-bridge.mjs` is the surface-neutral
  orchestrator; `vscode-extension/extension.mjs` is the only vscode-coupled file).
- **Run cancellation** — `core/run-registry.mjs`: process-local runId →
  AbortController registry; `/maestro-stop` aborts in-flight agents, `runPhase`
  wires the registry signal by default.

The runtime is still zero-deps (eslint and friends are devDependencies only).

Next: real-time in-TUI run monitoring (tracked as a separate issue), release
polish.
