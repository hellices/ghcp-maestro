# Design — Configurable agent scaling for `/maestro task`

- Status: **Approved**
- Date: 2026-08-05
- Issue: [#48](https://github.com/hellices/ghcp-maestro/issues/48)

## 1. Problem

`/maestro task` currently asks its planner for exactly 3–6 subtasks even
though the runtime can execute 16 agents concurrently and accepts up to 1,000
specs per `spawnAll` call. The planner limit prevents ordinary task runs from
using the runtime's available parallelism, while users have no way to request a
specific worker count or reduce concurrency for cost and resource control.

Agent count and concurrency are separate controls:

- **Agent count** is the total number of worker subtasks generated.
- **Concurrency** is the maximum number of those workers running at once.

## 2. User interface

`/maestro task` uses automatic sizing by default and accepts independent
overrides:

```text
/maestro task <task>
/maestro task --agents 12 <task>
/maestro task --concurrency 6 <task>
/maestro task --agents 30 --concurrency 16 <task>
```

- With no `--agents`, the planner chooses 3–16 workers according to the number
  of genuinely independent work units.
- `--agents N` requires exactly `N` planned workers. Explicit sizing accepts
  1–50 workers; 50 is the task-planner safety cap, separate from the lower-level
  runtime cap of 1,000.
- With no `--concurrency`, the existing runtime default of 16 applies.
- `--concurrency N` accepts 1–16 and limits simultaneous worker execution.
- Options are recognized only at the leading or trailing edge of the task line,
  matching the existing `--write` behavior. The same text in the middle of a
  natural-language request remains task content.
- Existing `--write` and `--allow-dirty` options compose with the new options.

## 3. Planning and execution

The planner prompt receives one of two sizing policies:

- **Automatic:** choose 3–16 non-duplicative subtasks. Use fewer workers when
  the task has few independent units.
- **Explicit:** return exactly `N` subtasks.

Plan parsing validates the effective policy. A wrong count produces parser
feedback and uses the existing single planner retry. A second wrong count fails
the run without starting workers.

The concurrency setting applies to each explore dependency layer. Plan, verify,
and synth remain single-agent phases. Dependencies can reduce observed
parallelism below the configured concurrency because only one topological layer
runs at a time.

## 4. Persistence and resume

The canonical task line persisted in `manifest.json` includes all effective
options:

```text
--agents 30 --concurrency 16 --write --allow-dirty <task>
```

This includes options supplied through programmatic workflow arguments, not
only options typed in the command. `/maestro-resume` therefore reconstructs the
same planner count, concurrency, and write policy without new manifest fields.
Previously successful agents continue to replay from the run cache.

## 5. Validation and failure behavior

Options are parsed before file references, run creation, repository checks, or
model calls.

- Missing values, non-integers, duplicate options, and out-of-range values fail
  with an actionable message.
- `--agents` range: 1–50.
- `--concurrency` range: 1–16.
- Empty task text after option removal fails before token spend.
- Unknown `--` tokens remain task text for backward compatibility.
- The approval gate continues to display the generated worker count and
  run-size estimate and allows the user to deselect workers.

## 6. Components

- `core/task-options.mjs` — pure edge-option parser, validation, and canonical
  task-line serializer.
- `core/plan.mjs` — automatic 3–16 policy, explicit exact-count prompt, and
  count-aware plan validation.
- `core/builtin-workflows.mjs` — resolve effective task options, persist their
  canonical form, and pass concurrency to explore phases.
- `extensions/ghcp-maestro/extension.mjs` and `core/help.mjs` — command summary
  and usage rendering.
- Tests cover pure parsing, prompt/plan validation, workflow propagation,
  concurrency forwarding, resume persistence, and help text.

## 7. Safety and compatibility

- `DEFAULT_CONCURRENCY=16` and `GLOBAL_AGENT_CAP=1000` remain unchanged.
- Saved workflows keep their existing `spawnAll` behavior.
- `/maestro brainstorm`, `/maestro hello`, and diagnostic commands are
  unchanged.
- Runtime remains zero-dependency and ESM-only.
- All user-visible runtime output continues through `session.log()`.

## 8. Documentation

Update the English and Korean READMEs, `docs/GUIDE.md`,
`docs/GUIDE.ko.md`, and the Unreleased changelog with:

- automatic 3–16 worker sizing;
- `--agents N`;
- `--concurrency N`;
- the distinction between total workers and simultaneous workers.
