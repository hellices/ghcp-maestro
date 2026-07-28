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
Plans may declare `dependsOn` between subtasks: dependents run in a later
wave with their dependencies' outputs injected into the prompt, and if a
dependency fails its dependents are skipped instead of running blind.

**Real parallel fan-out with isolation.**
Each subtask runs in its own child Copilot session, concurrently (default 16 at
a time, hard cap 1000). The host conversation stays clean, every subtask gets a
fresh context window, and the wall-clock time collapses to roughly the slowest
single subtask instead of their sum. Each agent has a generous timeout
(research agents default to 10 minutes); for very long research runs, raise it
with `GHCP_MAESTRO_TIMEOUT_MS=<ms>`. Transient agent failures (API blips,
rate limits) retry automatically with exponential backoff — once by default,
tunable with `GHCP_MAESTRO_RETRIES=<n>` (`0` disables).

**Cost visibility and a token budget.**
Before fan-out the gate shows a run-size estimate, and runs of
`GHCP_MAESTRO_LARGE_RUN_AGENTS` or more subtasks (default 5) get an explicit
warning. Token accounting is always on: every completed run logs its total
token usage and records it in the run manifest, so `/maestros` shows per-run
cost. Enforcement is opt-in — set `GHCP_MAESTRO_BUDGET_TOKENS=<n>`
(`500k` / `2m` shorthand works) to cap a run: once the cap is hit, in-flight
agents finish, un-started agents are skipped, and the run is soft-stopped —
resumable later with `/maestro-resume`. `/maestros` shows live per-agent and
total token usage.

**Model routing (opt-in).**
Worker agents doing mechanical subtasks rarely need the same model as the
planner or the synth phase. Set `GHCP_MAESTRO_MODEL_ROUTES` to a JSON map from
label pattern to model — labels are `plan`, `explore:<agent>`, `synth`; `*`
wildcards, first match wins:

```
GHCP_MAESTRO_MODEL_ROUTES='{"explore:*":"gpt-5-mini","synth":"claude-sonnet-4.5"}'
```

Unmatched labels (and no routes at all — the default) fall back to the child
session's default model.

**Verification before synthesis (opt-in).**
Set `GHCP_MAESTRO_VERIFY=1` to insert a verify phase between fan-out and
synthesis: one extra agent judges each subtask output against the original
task objective (met / partially-met / not-met, with concrete gaps) and the
report is fed to the synth agent so unverified claims aren't presented as
settled facts. Off by default — it costs one extra agent per run. A failed
verify agent never fails the run; synthesis proceeds without the report.

**OTel GenAI-style trace export.**
Every run that reaches a terminal state (complete / stopped / error) writes a
`trace.json` next to its manifest: one `invoke_workflow` root span plus an
`invoke_agent` span per agent, using OpenTelemetry GenAI semantic-convention
attribute names (`gen_ai.operation.name`, `gen_ai.agent.name`,
`gen_ai.conversation.id`, `gen_ai.usage.total_tokens`, `error.type`). It is an
OTel-style JSON document, not a full OTLP payload — post-process it into a
real exporter if you need one. (The upstream GenAI conventions are still in
Development status, so attribute names may drift.)

**Result synthesis.**
A `synth` agent cross-checks every subtask output and merges them into a final
answer plus suggested next actions. Failed subtasks are disclosed, not hidden:
the synth prompt marks them `(FAILED: <status>)` and instructs the agent to
state which angles are missing, and the final output includes a coverage line
(`coverage: 4/5 subtasks ok (1 timeout)`).

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

**Share workflows** — install someone else's workflow straight from GitHub:
```text
/maestro install acme/flows/workflows/security-audit.mjs@v1
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
| `/maestro install <source> [--force]` | Install a saved workflow from GitHub into your user dir |
| `/maestros [runId]` | List recent runs, or show one run's live dashboard |
| `/maestro-resume <runId>` | Resume a run; cached agents are skipped |
| `/maestro-stop <runId>` | Stop a run and abort its in-flight agents |
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

## Install surfaces

`/maestro` runs on two surfaces that **share one runtime core** (`core/*`, the
`@ghcp-maestro/core` package) but are **installed and distributed
separately**. The core is surface-agnostic; each surface is a thin adapter that
implements the ports in
[`core/ports.mjs`](core/ports.mjs)
(`RuntimePort` / `UiSinkPort` / `LogPort` / `CancellationPort`).

| Surface | Install | Run | UI |
| :-- | :-- | :-- | :-- |
| **GitHub Copilot CLI** | `copilot plugin install <repo>` | `copilot --experimental` | `/maestro` chat + `/maestros` text dashboard |
| **VS Code** | install the `ghcp-maestro` extension (`.vsix` or Marketplace) | open VS Code Chat | `@maestro` / `/maestro` chat + **Maestro** Activity Bar (Runs tree + interactive Run Console) |

Installing the CLI plugin does **not** install the VS Code extension (and vice
versa) — they are different distribution channels. Only the runtime core is
shared, so behavior and subcommands stay in lock-step.

### VS Code surface

The VS Code extension lives in [`vscode-extension/`](vscode-extension/). It adds:

- a **chat participant** (`@maestro`) that mirrors the CLI subcommands
  (`task`, `brainstorm`, `run`, `workflows`),
- a **Runs** TreeView (run → phase → agent, with live status icons and a dense
  `model · tokens · tools · time` line per agent), and
- an interactive **Run Console** webview — a TUI-like, three-pane view
  (Phases / Agents / Infrastructure) that streams live updates, lets you drill
  into any agent's prompt, tool trace, and output, and retry a single agent — all
  **inside VS Code**, no external browser.

Because the VS Code extension host runs on its own Electron/Node runtime (not the
Copilot binary), point the extension at the Copilot CLI so it can spawn isolated
agent sessions:

```jsonc
// settings.json
{
  "maestro.copilotPath": "/absolute/path/to/copilot"
}
```

Leave it empty to fall back to the `COPILOT_CLI_PATH` environment variable. Run
logs stream to the **Maestro** output channel.

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

- [docs/DEMO.md](docs/DEMO.md) — a five-minute end-to-end walkthrough
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — product vision and requirements
- [docs/PLAN.md](docs/PLAN.md) — milestones and design decisions
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release history

## License

MIT — see [LICENSE](LICENSE).
