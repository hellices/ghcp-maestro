# Feature guide & configuration

**English** | [한국어](GUIDE.ko.md)

The full tour of what ghcp-maestro does and every knob it exposes. For a
lean overview, start with the [README](../README.md); for a hands-on
walkthrough, see [DEMO.md](DEMO.md).

---

## Features in depth

### Automatic task decomposition

`/maestro task <natural language>` asks a `plan` agent to break the task into
3–6 independent subtasks — you describe the goal, it figures out the pieces.
Plans may declare `dependsOn` between subtasks: dependents run in a later
wave with their dependencies' outputs injected into the prompt, and if a
dependency fails its dependents are skipped instead of running blind.

### `@file` references — drive a run from a markdown spec

For anything too detailed to fit one chat line, write the request as a
markdown file and reference it with `@`:

```text
/maestro task @docs/refactor-spec.md focus on the API layer first
```

The host reads each `@path` (relative to the current directory; absolute
paths work too) **before the
run starts** and inlines the content — fenced, with the filename — into the
plan prompt and every subtask prompt. Each isolated child session therefore
sees the full spec without having to rediscover the file. The one-line text
that remains acts as the trigger and steer; the spec drives correctness.

Rules and limits:

- Up to 4 files per run; each file is capped at 16 000 characters of content
  (longer files are truncated and a short truncation marker is appended).
  The combined limit is 48 000 characters *including* those markers, so
  several truncated files can trip it slightly earlier than 3 × 16 000.
- A missing or unreadable file aborts immediately — before any agent spends
  a token.
- `/maestro brainstorm` accepts `@file` references the same way.
- The run manifest keeps the raw line, so `/maestro-resume` re-reads the
  files (and fails cleanly if a spec file has since disappeared). Relative
  paths resolve against the directory you resume from — resume from the same
  directory to get the same files.
- Remember every subtask prompt carries the spec: a big spec × a wide fan-out
  multiplies token cost. (The gate's low/medium/high estimate is based on
  agent count, not prompt size — factor the spec in yourself.)
- The referenced file contents are sent to the model in every prompt — never
  reference files containing secrets, credentials, or other sensitive data.

### Real parallel fan-out with isolation

Each subtask runs in its own child Copilot session, concurrently (default 16 at
a time, hard cap 1000). The host conversation stays clean, every subtask gets a
fresh context window, and the wall-clock time collapses to roughly the slowest
single subtask instead of their sum. Each agent has a generous timeout
(10 minutes by default — raise `GHCP_MAESTRO_TIMEOUT_MS` for very long research
runs), and transient failures (API blips, rate limits) retry automatically with
exponential backoff.

### Write mode — worktree-per-agent isolation (opt-in)

By default every agent runs read-only against your working directory, which is
safe for research, review, and audits. For repo-modifying work — migration
sweeps, batch refactoring, test generation — add `--write`:

```text
/maestro task --write Migrate every call of legacy restClient to graphqlClient
```

What changes:

- **Disjoint file scopes.** The plan agent must declare which files each
  subtask will modify, and no two subtasks may claim the same file (or a
  directory containing another subtask's files). Overlaps are rejected and the
  planner retries.
- **A worktree per agent.** Each subtask gets its own `git worktree` on a
  fresh branch `maestro/<runId>/<agent>` (under the run's data dir), and its
  prompt pins it there: work only in that directory, touch only the declared
  scope, commit the result.
- **Sequential integration.** After the fan-out, branches merge back into your
  current branch one at a time. Set `GHCP_MAESTRO_CHECK_CMD` (e.g. `npm test`)
  to run a check after each merge — the only known mitigation for semantic
  conflicts git can't detect. A conflict or check failure stops integration
  and reports exactly which branches merged and which are left for manual
  resolution; nothing is force-cleaned.
- **Safety rails.** Requires a clean git work tree (`--allow-dirty` to
  override) on a checked-out branch; refuses to run outside a git repository —
  all checked before a single token is spent. Worktrees with uncommitted work
  are never removed.

Known limitations (shared by every tool in this space): lockfiles and
generated files are a common conflict source — keep them out of subtask
scopes; and a passing check after each merge is still no guarantee two
changes compose semantically. Review the integrated result as you would a
human PR train.

### Pre-approval before fan-out

On an interactive host, ghcp-maestro pauses after planning to show the subtask
list with prompt previews. Approve everything, run only a subset, or abort —
before any of the expensive parallel work starts.

### Cost visibility and a token budget

Before fan-out the gate shows a run-size estimate, and runs of
`GHCP_MAESTRO_LARGE_RUN_AGENTS` or more subtasks (default 5) get an explicit
warning. Token accounting is always on for the task workflow: when the
workflow itself ends a run (complete, budget soft-stop, or failure) it records
the total token usage in the run manifest, so `/maestros` shows per-run cost
(a manual `/maestro-stop` on a still-running run may not have a final total).
Enforcement is opt-in — set `GHCP_MAESTRO_BUDGET_TOKENS=<n>`
(`500k` / `2m` shorthand works) to cap a run: once the cap is hit, in-flight
agents finish, un-started agents are skipped, and the run is soft-stopped —
resumable later with `/maestro-resume`. `/maestros` shows live per-agent and
total token usage.

### Model routing (opt-in)

Worker agents doing mechanical subtasks rarely need the same model as the
planner or the synth phase. Set `GHCP_MAESTRO_MODEL_ROUTES` to a JSON map from
label pattern to model — labels are `plan`, `explore:<agent>`, `verify`,
`synth`; `*` wildcards, first match wins:

```
GHCP_MAESTRO_MODEL_ROUTES='{"explore:*":"gpt-5-mini","synth":"claude-sonnet-4.5"}'
```

Unmatched labels (and no routes at all — the default) fall back to the child
session's default model.

### Verification before synthesis (opt-in)

Set `GHCP_MAESTRO_VERIFY=1` to insert a verify phase between fan-out and
synthesis: one extra agent judges each subtask output against the original
task objective (met / partially-met / not-met, with concrete gaps) and the
report is fed to the synth agent so unverified claims aren't presented as
settled facts. Off by default — it costs one extra agent per run. A failed
verify agent never fails the run; synthesis proceeds without the report.

### Result synthesis

A `synth` agent cross-checks every subtask output and merges them into a final
answer plus suggested next actions. Failed subtasks are disclosed, not hidden:
the synth prompt marks them `(FAILED: <status>)` and instructs the agent to
state which angles are missing, and the final output includes a coverage line
(`coverage: 4/5 subtasks ok (1 timeout)`).

### Persistence and resume

Every run is saved to disk. `/maestro-resume <runId>` replays it: already
finished agents are served from cache, only the missing or failed ones rerun.

### Background runs you can watch

`/maestro task|brainstorm|run` kick off in the background, so the session stays
free while agents fan out. Run `/maestros` to list runs with a live progress
summary, or `/maestros <runId>` for the full per-agent dashboard.

### OTel GenAI-style trace export

Every run that reaches a terminal state (complete / stopped / error) writes a
`trace.json` next to its manifest (best-effort — a trace write failure is
swallowed and never fails the run): one `invoke_workflow` root span plus an
`invoke_agent` span per agent, using OpenTelemetry GenAI semantic-convention
attribute names (`gen_ai.operation.name`, `gen_ai.agent.name`,
`gen_ai.conversation.id`, `gen_ai.usage.total_tokens`, `error.type`). It is an
OTel-style JSON document, not a full OTLP payload — post-process it into a
real exporter if you need one. (The upstream GenAI conventions are still in
Development status, so attribute names may drift.)

### Brainstorming

`/maestro brainstorm <topic>` fans out several perspective-specific agents in
parallel, then synthesizes across the perspectives.

### Saved workflows

Capture a repeatable multi-step procedure as a small workflow script and run it
with `/maestro run <name>`. Scripts only ever touch a sandboxed API
(`spawn`/`spawnAll`/`phase` plus the quality helpers) — never the filesystem,
shell, or SDK directly. `/maestro install <owner>/<repo>/<path>[@ref]` fetches a
workflow file straight from GitHub into your user workflows directory,
validating it (without executing) and warning that workflows run with your
session's permissions.

### Quality helpers

Reusable multi-agent patterns for workflow authors: `adversarialReview`
(reviewers try to rebut each finding), `multiAngle` (draft from several angles,
then judge), `fixLoop` (retry until a check passes), and `crossCheck` (verify a
claim across multiple sources).

---

## Configuration

Everything is tuned through environment variables — visibility features are
always on, and everything that spends extra tokens is opt-in. (Diagnostic
probe knobs — `GHCP_MAESTRO_PROBE_*`, `GHCP_MAESTRO_TIMEOUT_PROBE_MS` — are
intentionally omitted here.)

| Variable | Default | What it does |
| :-- | :-- | :-- |
| `GHCP_MAESTRO_AUTO_APPROVE` | off | Skip the plan approval gate; always run every subtask |
| `GHCP_MAESTRO_BUDGET_TOKENS` | unlimited | Token cap per run attempt (`500k` / `2m` shorthand); soft-stops the run when hit |
| `GHCP_MAESTRO_MODEL_ROUTES` | none | JSON map of agent label → model (`plan`, `explore:<agent>`, `verify`, `synth`; `*` wildcards) |
| `GHCP_MAESTRO_VERIFY` | off | Insert a verify phase between fan-out and synthesis (one extra agent per run) |
| `GHCP_MAESTRO_CHECK_CMD` | off | Write mode: shell command (e.g. `npm test`) run after each branch merge; failure stops integration |
| `GHCP_MAESTRO_TIMEOUT_MS` | `600000` (10 min) | Per-agent timeout |
| `GHCP_MAESTRO_RETRIES` | `1` | Automatic retries for transient agent failures (`0` disables) |
| `GHCP_MAESTRO_LARGE_RUN_AGENTS` | `5` | Subtask count that triggers the "large fan-out" warning at the gate |
| `GHCP_MAESTRO_NO_MONITOR` | off | Disable live progress tracking |
| `GHCP_MAESTRO_DATA_DIR` | `~/.copilot/plugin-data/ghcp-maestro` | Where run state (manifests, agent outputs, traces) is stored |
| `GHCP_MAESTRO_WORKFLOWS_DIR` | `<cwd>/.ghcp-maestro/workflows` | Project-level saved-workflows directory (highest priority) |
