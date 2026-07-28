# Demo — one `/maestro task` run, end to end

A five-minute walkthrough of the core workflow: decompose a task, approve the
plan, fan out parallel child sessions, and get one synthesized answer. Log
lines below are the real formats the plugin emits (run ids and timings will
differ on your machine).

## 0. Install

```sh
copilot plugin marketplace add hellices/ghcp-maestro
copilot plugin install ghcp-maestro@ghcp-maestro
```

Then start the CLI with the experimental extensions flag — the plugin does not
load without it:

```sh
copilot --experimental
```

On startup you should see (ephemeral):

```text
ghcp-maestro extension loaded. Run '/maestro help' for subcommands. 1 saved workflow(s): deep-review.
```

Sanity checks: `/extensions info ghcp-maestro` shows the registered surface,
`/maestro help` lists every subcommand.

## 1. Kick off a task

```text
/maestro task Evaluate whether we should adopt a monorepo: tooling, CI, code sharing, team workflow, and the migration cost — with a recommendation
```

The run starts in the background — your session stays free:

```text
ghcp-maestro/run-mf3k2a-x7q9p1: running in background — watch with /maestros run-mf3k2a-x7q9p1
ghcp-maestro/run-mf3k2a-x7q9p1: phase=plan agents=1
```

## 2. Plan → approval gate

One planner child session decomposes the task, then (on interactive hosts) a
dialog lets you approve, drop a subset, or abort before anything expensive
runs:

```text
ghcp-maestro/run-mf3k2a-x7q9p1: plan produced 5 subtask(s): tooling, ci-pipeline, code-sharing, team-workflow, migration-cost
ghcp-maestro/run-mf3k2a-x7q9p1: est. run size: medium (7 agents incl. plan+synth)
ghcp-maestro/run-mf3k2a-x7q9p1: large fan-out: 5 subtask(s) — each runs its own child session; consider narrowing the selection at the gate
ghcp-maestro/run-mf3k2a-x7q9p1: plan ready: 5 subtask(s) — est. run size: medium (7 agents incl. plan+synth) — review before fan-out:
```

Untick a subtask in the dialog to skip it. After accepting:

```text
ghcp-maestro/run-mf3k2a-x7q9p1: user approved 5/5 subtask(s): tooling, ci-pipeline, code-sharing, team-workflow, migration-cost
```

Non-interactive hosts (CI, `copilot -p`) auto-approve everything, as does
`GHCP_MAESTRO_AUTO_APPROVE=1`.

## 3. Explore — parallel fan-out

Each subtask runs in its own isolated child Copilot session:

```text
ghcp-maestro/run-mf3k2a-x7q9p1: phase=explore agents=5 (parallel)
```

Watch live progress any time from the same session:

```text
/maestros run-mf3k2a-x7q9p1
```

```text
run-mf3k2a-x7q9p1 · 2/5 done · 01:12 · 18.4K tok
  ✓ tooling  done  48s  6.2KB  7.1K tok
  ✓ ci-pipeline  done  63s  5.8KB  6.4K tok
  ⠿ code-sharing  streaming  72s  3.1KB  3.2K tok
  ⠿ team-workflow  tool  70s  1.9KB  (bash)  1.7K tok
  · migration-cost  pending  0s
```

(If the plan declared `dependsOn` between subtasks, the explore phase runs
layer by layer instead: `phase=explore agents=5 layers=2 (topological)` — see
the DAG section in the README.)

## 4. Synthesize

A final child session cross-checks the subtask outputs and merges them:

```text
ghcp-maestro/run-mf3k2a-x7q9p1: phase=synth agents=1
ghcp-maestro/run-mf3k2a-x7q9p1: coverage: 5/5 subtasks ok
ghcp-maestro/run-mf3k2a-x7q9p1: task workflow complete — 7 agents across 3 phases (plan + explore[5] + synth)
```

…followed by the synthesized answer itself. If some subtasks failed, the
coverage line says so (`coverage: 4/5 subtasks ok (1 error)`) and the answer
explicitly lists which angles are missing rather than papering over them.

## 5. Resume / stop (when things go sideways)

Every run persists under the plugin data dir, so a crashed or stopped run can
pick up where it left off — completed agents are replayed from cache, only the
unfinished ones rerun:

```text
/maestro-resume run-mf3k2a-x7q9p1
```

`/maestros` (no arg) lists recent runs; `/maestro-stop <runId>` aborts a run's
in-flight agents and marks it stopped (still resumable).

## Variations worth trying

| Try | Command |
| :-- | :-- |
| Multi-perspective brainstorm | `/maestro brainstorm Ways to cut our cloud bill without hurting reliability` |
| Saved workflow (bundled) | `/maestro run deep-review {"topic": "the diff on this branch"}` |
| Install a shared workflow | `/maestro install owner/repo/path/flow.mjs@v1` |
| Cap a run's token spend | `GHCP_MAESTRO_BUDGET_TOKENS=500k copilot --experimental` |
| Auto-retry transient errors | on by default (`GHCP_MAESTRO_RETRIES=1`; `0` disables) |
