# ghcp-maestro

**English** | [한국어](README.ko.md)

> Multi-agent workflow runtime for GitHub Copilot CLI.

Give ghcp-maestro a task in plain language and it splits the work into several
independent subtasks, runs each one in its **own isolated child Copilot session
— truly in parallel —** and then merges the results into a single answer. It
ships as a single GitHub Copilot CLI plugin: no extra CLI, no daemon, no
external service.

![A /maestro task run: plan → approval gate → parallel fan-out with a live agent dashboard → synthesized final answer](docs/assets/demo.gif)

<sub>Scripted replay of a `/maestro task` run — the log lines closely mirror
the runtime's real output; color is added and timings are compressed for the
GIF. Regenerate with [`vhs demo/demo.tape`](demo/demo.tape).</sub>

> ghcp-maestro is a GitHub Copilot CLI take on the **orchestrator-workers**
> pattern: plan → fan out parallel agents → cross-check → one synthesized answer,
> with runs persisted so they can be resumed.

---

## Quick start

ghcp-maestro uses the **experimental extensions** surface of the GitHub Copilot
CLI, so it needs GitHub Copilot CLI ≥ 1.0.65 (Node.js 20+) and the
`--experimental` flag.

```bash
# Install the plugin from the repository root
copilot plugin install "$(pwd)"     # PowerShell: copilot plugin install (Get-Location)

# Start a session with the experimental surface enabled
copilot --experimental
```

Then, inside the session:

```text
/maestro help
/maestro task Draft a migration plan from REST to GraphQL for our API
```

On an interactive host, `/maestro task` will ask you to approve the plan before
fanning out. Set `GHCP_MAESTRO_AUTO_APPROVE=1` to skip that prompt and always
run every subtask.

---

## What you can do with it

`/maestro task` shines on work that is too big for a single back-and-forth — the
kind of parallel, cross-checked investigation that would otherwise take many
manual turns. A few examples:

**Codebase audit** — sweep a whole area for one class of problem, in parallel.
```text
/maestro task Audit every route under src/api for missing authentication or input validation, and list each gap with the file and a suggested fix
```

**Cross-checked research** — gather findings from several independent angles and
keep only what survives scrutiny.
```text
/maestro task Compare PostgreSQL, MySQL, and SQLite for a write-heavy multi-tenant SaaS, cross-checking performance, operations, cost, and migration effort
```

**Sizing workers** — ask for a specific total worker count or cap simultaneous
workers when you need tighter control.
```text
/maestro task Audit every API route
/maestro task --agents 12 Audit every package independently
/maestro task --agents 30 --concurrency 8 Migrate each independent module
```

**Decision / trade-off analysis** — evaluate one decision from multiple lenses
at once.
```text
/maestro task Evaluate whether we should adopt a monorepo: tooling, CI, code sharing, team workflow, and the migration cost — with a recommendation
```

**Multi-angle brainstorming** — explore a fuzzy topic from fixed perspectives.
```text
/maestro brainstorm Ways to cut our cloud bill without hurting reliability
```

**Detailed requests from a spec file** — when one line isn't enough, write the
request as markdown and reference it with `@`; the spec is inlined into the
plan and every subtask.
```text
/maestro task @docs/refactor-spec.md focus on the API layer first
```

**Repo-modifying sweeps** — opt into write mode and each subtask gets its own
git worktree and branch, merged back sequentially with an optional check
command between merges.
```text
/maestro task --write Migrate every call of legacy restClient to graphqlClient
```

**Repeatable workflows** — once a procedure works, save it as a script and rerun
it as its own command, or install someone else's straight from GitHub:
```text
/maestro run deep-review {"topic": "the diff on this branch"}
/maestro install acme/flows/workflows/security-audit.mjs@v1
```

---

## Commands

| Command | What it does |
| :-- | :-- |
| `/maestro task <natural language>` | Decompose → (approve) → parallel fan-out → synthesize |
| `/maestro brainstorm <topic>` | Multi-perspective brainstorm → synthesize |
| `/maestro run <name> [args]` | Run a saved workflow (`args`: JSON object or plain text) |
| `/maestro workflows` | List the saved workflows available to you |
| `/maestro install <source> [--force]` | Install a saved workflow from GitHub into your user dir |
| `/maestros [runId]` | List recent runs, or show one run's live dashboard |
| `/maestro-resume <runId>` | Resume a run; cached agents are skipped |
| `/maestro-stop <runId>` | Stop a run (aborts in-flight agents when run from the owning session) |
| `/maestro help` | List every subcommand |

---

## Features at a glance

- **Automatic task decomposition** — a `plan` agent automatically sizes the
  task into 3–16 subtasks; `--agents N` (1–50) sets the exact total worker
  count, while `--concurrency N` (1–16) limits how many run at once.
  Duplicate options are rejected.
- **`@file` references** — `/maestro task @docs/spec.md …` inlines a markdown
  spec into the plan and every subtask prompt.
- **Write mode (opt-in)** — `--write` gives each subtask an isolated git
  worktree + branch with disjoint file scopes, then integrates sequentially.
- **Real parallel fan-out with isolation** — every subtask gets its own child
  Copilot session and a fresh context window; wall-clock ≈ slowest subtask.
- **Pre-approval gate** — review the plan, run a subset, or abort before any
  expensive fan-out starts.
- **Cost visibility + opt-in token budget** — run-size estimate at the gate,
  always-on token accounting, `GHCP_MAESTRO_BUDGET_TOKENS` soft-stop.
- **Model routing (opt-in)** — route workers to cheaper models than the
  planner/synth via `GHCP_MAESTRO_MODEL_ROUTES`.
- **Verify phase (opt-in)** — `GHCP_MAESTRO_VERIFY=1` judges each subtask
  against the objective before synthesis.
- **Result synthesis** — cross-checked final answer with failed subtasks
  disclosed (`coverage: 4/5 subtasks ok`).
- **Persistence & resume** — every run is on disk; `/maestro-resume` reruns
  only what's missing.
- **Background runs + live dashboard** — `/maestros` shows per-agent progress
  and token usage while you keep working.
- **OTel GenAI-style trace export** — best-effort `trace.json` per finished run.
- **Saved workflows & quality helpers** — sandboxed workflow scripts,
  `adversarialReview` / `multiAngle` / `fixLoop` / `crossCheck`.

The full tour — each feature in depth plus every `GHCP_MAESTRO_*` environment
variable — lives in **[docs/GUIDE.md](docs/GUIDE.md)**.

---

## Known limitations

- **`copilot --experimental` is required.** The extensions surface is behind
  the CLI's experimental feature flag; without it the plugin never loads.
- **Fan-out multiplies cost.** Every subtask is a real child Copilot session.
  The plan gate shows a run-size estimate, and `GHCP_MAESTRO_BUDGET_TOKENS`
  soft-stops a run over budget — but the spend is real. Start small.
- **Workflows are code.** Saved/installed workflows run with your session's
  permissions. `/maestro install` validates without executing and warns, but
  reviewing the file before `/maestro run` is on you.
- **The plan approval gate needs an interactive host.** Hosts without
  elicitation support (CI, `copilot -p`) auto-approve every subtask.
- **`/maestro-stop` aborts in-flight agents only from the session that started
  the run.** From another session it marks the run stopped; already-running
  child sessions finish on their own.
- **`/maestro install` blob URLs can't carry a `/` in the ref** (e.g.
  `feature/x` branches) — use the raw URL or the `owner/repo/path@ref`
  shorthand instead.

## Learn more

- [docs/GUIDE.md](docs/GUIDE.md) — every feature in depth + the full configuration reference
- [docs/DEMO.md](docs/DEMO.md) — a five-minute end-to-end walkthrough
- [docs/SURFACES.md](docs/SURFACES.md) — CLI vs. VS Code install surfaces and the shared core
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — product vision and requirements
- [docs/PLAN.md](docs/PLAN.md) — milestones and design decisions
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release history

## License

MIT — see [LICENSE](LICENSE).
