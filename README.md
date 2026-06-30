# ghcp-maestro

**English** | [한국어](README.ko.md)

> Multi-agent workflow runtime for GitHub Copilot CLI.

Give ghcp-maestro a task in plain language and it splits the work into several
independent subtasks, runs each one in its **own isolated child Copilot session
— truly in parallel —** and then merges the results into a single answer. It
ships as a single GitHub Copilot CLI plugin: no extra CLI, no daemon, no
external service.

```text
/maestro task Analyze the trade-offs of moving our auth module to JWT
```

---

## Features

**Automatic task decomposition.**
`/maestro task <natural language>` asks a `plan` agent to break the task into
3–6 independent subtasks — you describe the goal, it figures out the pieces.

**Real parallel fan-out with isolation.**
Each subtask runs in its own child Copilot session, concurrently (default 16 at
a time, hard cap 1000). The host conversation stays clean, every subtask gets a
fresh context window, and the wall-clock time collapses to roughly the slowest
single subtask instead of their sum.

**Result synthesis.**
A `synth` agent cross-checks every subtask output and merges them into a final
answer plus suggested next actions.

**Pre-approval before fan-out.**
On an interactive host, ghcp-maestro pauses after planning to show the subtask
list with prompt previews. Approve everything, run only a subset, or abort —
before any of the expensive parallel work starts.

**Persistence and resume.**
Every run is saved to disk. `/maestro-resume <runId>` replays it: already
finished agents are served from cache, only the missing or failed ones rerun.

**Background runs you can watch.**
`/maestro task|brainstorm|run` kick off in the background, so the session stays
free while agents fan out. Run `/maestros` to list runs with a live progress
summary, or `/maestros <runId>` for the full per-agent dashboard. Opt out of
progress tracking with `GHCP_MAESTRO_NO_MONITOR=1`.

**Brainstorming.**
`/maestro brainstorm <topic>` fans out several perspective-specific agents in
parallel, then synthesizes across the perspectives.

**Saved workflows.**
Capture a repeatable multi-step procedure as a small workflow script and run it
with `/maestro run <name>`. Scripts only ever touch a sandboxed API
(`spawn`/`spawnAll`/`phase` plus the quality helpers) — never the filesystem,
shell, or SDK directly.

**Quality helpers.**
Reusable multi-agent patterns for workflow authors: `adversarialReview`
(reviewers try to rebut each finding), `multiAngle` (draft from several angles,
then judge), `fixLoop` (retry until a check passes), and `crossCheck` (verify a
claim across multiple sources).

---

## What you can do with it

`/maestro task` shines on work that is too big for a single back-and-forth — the
kind of parallel, cross-checked investigation that would otherwise take many
manual turns. A few examples:

**Codebase audit** — sweep a whole area for one class of problem, in parallel.
```text
/maestro task Audit every route under src/api for missing authentication or input validation, and list each gap with the file and a suggested fix
```

**Large migration / refactor planning** — break a daunting change into a
coordinated set of angles.
```text
/maestro task Plan migrating our REST API to GraphQL: schema design, resolver structure, auth, pagination, and a phased rollout with risks
```

**Cross-checked research** — gather findings from several independent angles and
keep only what survives scrutiny.
```text
/maestro task Compare PostgreSQL, MySQL, and SQLite for a write-heavy multi-tenant SaaS, cross-checking performance, operations, cost, and migration effort
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

**Repeatable workflows** — once a procedure works, save it as a script and rerun
it as its own command (e.g. a deep code review you run on every branch):
```text
/maestro run deep-review {"topic": "the diff on this branch"}
```

> ghcp-maestro is a GitHub Copilot CLI take on the **orchestrator-workers**
> pattern: plan → fan out parallel agents → cross-check → one synthesized answer,
> with runs persisted so they can be resumed.

---

## Commands

| Command | What it does |
| :-- | :-- |
| `/maestro task <natural language>` | Decompose → (approve) → parallel fan-out → synthesize |
| `/maestro brainstorm <topic>` | Multi-perspective brainstorm → synthesize |
| `/maestro run <name> [args]` | Run a saved workflow (`args`: JSON object or plain text) |
| `/maestro workflows` | List the saved workflows available to you |
| `/maestros [runId]` | List recent runs, or show one run's live dashboard |
| `/maestro-resume <runId>` | Resume a run; cached agents are skipped |
| `/maestro-stop <runId>` | Mark a run as stopped |
| `/maestro help` | List every subcommand |

---

## Getting started

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

## Learn more

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — product vision and requirements
- [docs/PLAN.md](docs/PLAN.md) — milestones and design decisions
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release history

## License

MIT — see [LICENSE](LICENSE).
