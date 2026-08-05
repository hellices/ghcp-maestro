# Configurable Agent Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/maestro task` size its worker fan-out automatically from 3–16
agents or accept explicit total-agent and concurrency overrides.

**Architecture:** Add a pure task-option boundary that parses and serializes all
task-line options before any side effect. Pass the resulting sizing policy into
the existing planner parser and only pass concurrency to explore phases; persist
the canonical option line so resume reconstructs the same policy. Implements
`docs/specs/2026-08-05-configurable-agent-scaling-design.md` for issue #48.

**Tech Stack:** Node.js 20+ ESM, `node:test`, `node:assert/strict`, existing
zero-dependency concurrency and workflow core.

## Global Constraints

- Runtime output goes through `session.log()` only.
- Runtime remains zero-dependency and ESM-only.
- Automatic planning accepts 3–16 workers.
- Explicit `--agents N` accepts 1–50 and requires exactly `N` plan entries.
- Explicit `--concurrency N` accepts 1–16.
- `DEFAULT_CONCURRENCY=16` and `GLOBAL_AGENT_CAP=1000` remain unchanged.
- Task options are validated before file IO, run creation, git checks, or model
  calls.
- Effective options are serialized into the manifest task line for resume.
- Existing `--write`, `--allow-dirty`, `@file`, approval, budget, routing,
  verify, and saved-workflow behavior stays compatible.
- Tests assert key human-readable tokens, not complete log strings.
- Run `npm run check` before every commit.
- Every commit includes
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File Structure

- Create `core/task-options.mjs` — task-line option constants, parsing,
  validation, override resolution, and canonical serialization.
- Create `tests/task-options.test.mjs` — pure option-boundary coverage.
- Modify `core/write-mode.mjs` — import shared write-option constants; remove
  the superseded write-only parser.
- Modify `tests/write-mode.test.mjs` — move parsing assertions to the new suite.
- Modify `core/plan.mjs` — automatic/exact sizing prompt and parser policy.
- Modify `tests/plan-parse.test.mjs` — sizing-policy tests.
- Modify `core/builtin-workflows.mjs` — resolve/persist options and forward
  explore concurrency.
- Modify `tests/builtin-workflows.test.mjs` — workflow and resume coverage.
- Modify `extensions/ghcp-maestro/extension.mjs`, `tests/help.test.mjs` — help
  copy.
- Modify `README.md`, `README.ko.md`, `docs/GUIDE.md`, `docs/GUIDE.ko.md`, and
  `docs/CHANGELOG.md` — user-facing behavior.

---

### Task 1: Pure task option boundary

**Files:**
- Create: `core/task-options.mjs`
- Create: `tests/task-options.test.mjs`
- Modify: `core/write-mode.mjs`
- Modify: `tests/write-mode.test.mjs`

**Interfaces:**
- Produces:
  - `MIN_EXPLICIT_AGENTS = 1`
  - `MAX_EXPLICIT_AGENTS = 50`
  - `MIN_TASK_CONCURRENCY = 1`
  - `MAX_TASK_CONCURRENCY = 16`
  - `parseTaskOptions(raw, overrides?)`
  - `serializeTaskOptions(options)`
- `parseTaskOptions` returns:

```js
{
  task: string,
  write: boolean,
  allowDirty: boolean,
  agents: number | undefined,
  concurrency: number | undefined,
}
```

- [ ] **Step 1: Write failing option parser tests**

Create `tests/task-options.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskOptions,
  serializeTaskOptions,
  MAX_EXPLICIT_AGENTS,
  MAX_TASK_CONCURRENCY,
} from "../core/task-options.mjs";

test("task options default to automatic sizing", () => {
  assert.deepEqual(parseTaskOptions("audit the API"), {
    task: "audit the API",
    write: false,
    allowDirty: false,
    agents: undefined,
    concurrency: undefined,
  });
});

test("task options compose at the leading edge", () => {
  assert.deepEqual(
    parseTaskOptions("--write --allow-dirty --agents 30 --concurrency 6 migrate"),
    {
      task: "migrate",
      write: true,
      allowDirty: true,
      agents: 30,
      concurrency: 6,
    },
  );
});

test("task options compose at the trailing edge", () => {
  const got = parseTaskOptions("migrate --agents 12 --concurrency 4 --write");
  assert.equal(got.task, "migrate");
  assert.equal(got.agents, 12);
  assert.equal(got.concurrency, 4);
  assert.equal(got.write, true);
});

test("option-like text in the middle remains task content", () => {
  assert.equal(
    parseTaskOptions("explain --agents 12 behavior").task,
    "explain --agents 12 behavior",
  );
});

test("invalid, duplicate, and empty task options fail", () => {
  assert.throws(() => parseTaskOptions("--agents nope audit"), /--agents.*integer/i);
  assert.throws(() => parseTaskOptions("--agents 2 --agents 3 audit"), /duplicate.*--agents/i);
  assert.throws(() => parseTaskOptions(`--agents ${MAX_EXPLICIT_AGENTS + 1} audit`), /1-50/);
  assert.throws(() => parseTaskOptions(`--concurrency ${MAX_TASK_CONCURRENCY + 1} audit`), /1-16/);
  assert.throws(() => parseTaskOptions("--agents 4"), /task description/i);
});

test("programmatic overrides are validated and serialized canonically", () => {
  const options = parseTaskOptions("--write migrate", { agents: 30, concurrency: 16 });
  assert.equal(
    serializeTaskOptions(options),
    "--agents 30 --concurrency 16 --write migrate",
  );
});
```

Move the existing `parseWriteFlags` edge-preservation cases from
`tests/write-mode.test.mjs` into this suite and extend them with multiline task
text.

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
node --test tests/task-options.test.mjs
```

Expected: FAIL because `core/task-options.mjs` does not exist.

- [ ] **Step 3: Implement the pure parser**

Create `core/task-options.mjs` with these exports and behavior:

```js
export const WRITE_FLAG = "--write";
export const ALLOW_DIRTY_FLAG = "--allow-dirty";
export const AGENTS_FLAG = "--agents";
export const CONCURRENCY_FLAG = "--concurrency";
export const MIN_EXPLICIT_AGENTS = 1;
export const MAX_EXPLICIT_AGENTS = 50;
export const MIN_TASK_CONCURRENCY = 1;
export const MAX_TASK_CONCURRENCY = 16;

export function parseTaskOptions(raw, overrides = {}) {
  const parsed = parseEdgeOptions(String(raw ?? ""));
  const options = {
    ...parsed,
    write: overrides.write ?? parsed.write,
    allowDirty: overrides.allowDirty ?? parsed.allowDirty,
    agents: overrides.agents ?? parsed.agents,
    concurrency: overrides.concurrency ?? parsed.concurrency,
  };
  validateRange(AGENTS_FLAG, options.agents, MIN_EXPLICIT_AGENTS, MAX_EXPLICIT_AGENTS);
  validateRange(
    CONCURRENCY_FLAG,
    options.concurrency,
    MIN_TASK_CONCURRENCY,
    MAX_TASK_CONCURRENCY,
  );
  if (!options.task) throw new Error("task options: task description is required");
  return options;
}

export function serializeTaskOptions(options) {
  return [
    options.agents === undefined ? null : `${AGENTS_FLAG} ${options.agents}`,
    options.concurrency === undefined
      ? null
      : `${CONCURRENCY_FLAG} ${options.concurrency}`,
    options.write ? WRITE_FLAG : null,
    options.allowDirty ? ALLOW_DIRTY_FLAG : null,
    options.task,
  ]
    .filter(Boolean)
    .join(" ");
}
```

Implement the private helpers as follows so recognized options are stripped
only at the edges and interior whitespace and newlines remain byte-stable:

```js
const LEADING_OPTION_RE =
  /^(?:(--write|--allow-dirty)(?=\s|$)|(--agents|--concurrency)\s+(\S+)(?=\s|$))(?:\s+|$)/;
const TRAILING_OPTION_RE =
  /(?:^|\s)(?:(--write|--allow-dirty)|(--agents|--concurrency)\s+(\S+))$/;

function parseEdgeOptions(raw) {
  const state = {
    task: raw.trim(),
    write: false,
    allowDirty: false,
    agents: undefined,
    concurrency: undefined,
  };
  const seen = new Set();
  const take = (name, rawValue) => {
    if (seen.has(name)) throw new Error(`task options: duplicate ${name}`);
    seen.add(name);
    if (name === WRITE_FLAG) state.write = true;
    else if (name === ALLOW_DIRTY_FLAG) state.allowDirty = true;
    else {
      const value = Number(rawValue);
      if (!Number.isInteger(value)) {
        throw new Error(`task options: ${name} must be an integer`);
      }
      if (name === AGENTS_FLAG) state.agents = value;
      else state.concurrency = value;
    }
  };

  let match;
  while ((match = state.task.match(LEADING_OPTION_RE))) {
    take(match[1] ?? match[2], match[3]);
    state.task = state.task.slice(match[0].length);
  }
  while ((match = state.task.match(TRAILING_OPTION_RE))) {
    take(match[1] ?? match[2], match[3]);
    state.task = state.task.slice(0, match.index).trimEnd();
  }
  state.task = state.task.trim();
  return state;
}

function validateRange(name, value, min, max) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`task options: ${name} must be an integer in the range ${min}-${max}`);
  }
}
```

In `core/write-mode.mjs`, import `WRITE_FLAG` and `ALLOW_DIRTY_FLAG` from
`task-options.mjs`, re-export them for compatibility, and delete the old
`parseWriteFlags`. Update `core/builtin-workflows.mjs` only enough to remove the
old parser import; full workflow wiring belongs to Task 3.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/task-options.test.mjs tests/write-mode.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add core/task-options.mjs core/write-mode.mjs \
  tests/task-options.test.mjs tests/write-mode.test.mjs
git commit -m "feat: parse configurable task scaling options

Refs #48

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Planner sizing policy

**Files:**
- Modify: `core/plan.mjs`
- Modify: `tests/plan-parse.test.mjs`

**Interfaces:**
- `MIN_PLAN_ENTRIES` remains `3`.
- `MAX_PLAN_ENTRIES` becomes `16` for automatic sizing.
- `buildPlanPrompt(..., sizing?)` accepts `{ agentCount?: number }`.
- `parseAndValidatePlan(text, opts?)` accepts
  `{ requireFiles?: boolean, agentCount?: number }`.

- [ ] **Step 1: Write failing planner policy tests**

Add to `tests/plan-parse.test.mjs`:

```js
test("automatic planning accepts up to 16 entries", () => {
  const plan = JSON.stringify(
    Array.from({ length: 16 }, (_, i) => ({ agent: `a${i}`, prompt: "p" })),
  );
  assert.equal(parse(plan).length, 16);
});

test("automatic planning rejects more than 16 entries", () => {
  const plan = JSON.stringify(
    Array.from({ length: 17 }, (_, i) => ({ agent: `a${i}`, prompt: "p" })),
  );
  assert.throws(() => parse(plan), /3-16 entries/);
});

test("explicit planning requires the exact requested count", () => {
  assert.throws(() => parse(VALID, { agentCount: 4 }), /exactly 4 entries/);
  assert.equal(parse(VALID, { agentCount: 3 }).length, 3);
});

test("plan prompt distinguishes automatic and explicit sizing", () => {
  assert.match(buildPlanPrompt("T"), /choose between 3 and 16/i);
  assert.match(buildPlanPrompt("T", undefined, undefined, undefined, false, { agentCount: 12 }), /exactly 12/i);
});
```

- [ ] **Step 2: Run planner tests and verify RED**

```bash
node --test tests/plan-parse.test.mjs
```

Expected: FAIL because the current parser rejects 16 entries and ignores
`agentCount`.

- [ ] **Step 3: Implement policy-aware prompt and validation**

Change `MAX_PLAN_ENTRIES` to `16`. Add a sixth optional argument to
`buildPlanPrompt`:

```js
export function buildPlanPrompt(
  task,
  parserError,
  previousReply,
  refsBlock,
  writeMode,
  { agentCount } = {},
) {
  const sizingRule =
    agentCount === undefined
      ? `Choose between ${MIN_PLAN_ENTRIES} and ${MAX_PLAN_ENTRIES} subtasks based on genuinely independent work units.`
      : `Return exactly ${agentCount} subtasks.`;
  // Include sizingRule in the opening instruction and Rules list.
}
```

In `parseAndValidatePlan`, derive the count failure before validating entries:

```js
const expected = opts.agentCount;
if (expected !== undefined && parsed.length !== expected) {
  throw new Error(`plan must have exactly ${expected} entries, got ${parsed.length}`);
}
if (
  expected === undefined &&
  (parsed.length < MIN_PLAN_ENTRIES || parsed.length > MAX_PLAN_ENTRIES)
) {
  throw new Error(
    `plan must have ${MIN_PLAN_ENTRIES}-${MAX_PLAN_ENTRIES} entries, got ${parsed.length}`,
  );
}
```

Do not cap explicit counts here; `task-options.mjs` owns the 1–50 validation.
This also allows explicit 1–2 worker plans.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node --test tests/plan-parse.test.mjs
```

Expected: all plan tests pass.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add core/plan.mjs tests/plan-parse.test.mjs
git commit -m "feat: support automatic and exact planner sizing

Refs #48

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Workflow propagation, concurrency, and resume

**Files:**
- Modify: `core/builtin-workflows.mjs`
- Modify: `tests/builtin-workflows.test.mjs`

**Interfaces:**
- `runTaskWorkflow(session, rawTask, opts)` accepts optional `opts.agents` and
  `opts.concurrency`.
- Effective concurrency is `taskOptions.concurrency ?? DEFAULT_CONCURRENCY`.
- Only explore-layer `runPhase` calls receive the effective concurrency.
- Manifest `args.task` is `serializeTaskOptions(taskOptions)`.

- [ ] **Step 1: Write failing workflow tests**

Add deterministic tests to `tests/builtin-workflows.test.mjs`:

```js
test("task workflow requests and validates an explicit agent count", async () => {
  await withTempDataDir(async () => {
    let planPrompt;
    const adapter = () => ({
      name: "explicit-count",
      async invoke(spec) {
        if (spec.agent === "plan") {
          planPrompt = spec.prompt;
          return {
            text: JSON.stringify(
              Array.from({ length: 4 }, (_, i) => ({
                agent: `a${i}`,
                prompt: `p${i}`,
              })),
            ),
          };
        }
        return { text: `out-${spec.agent}` };
      },
    });
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: adapter });
    const run = await runTaskWorkflow(fakeSession(), "--agents 4 do the thing");
    assert.equal(run.manifest.status, "complete");
    assert.match(planPrompt, /exactly 4/i);
    assert.equal(run.manifest.args.task, "--agents 4 do the thing");
  });
});

test("task workflow forwards configured concurrency to every explore layer", async () => {
  await withTempDataDir(async () => {
    const phaseCalls = [];
    const executePhase = async (specs, opts) => {
      phaseCalls.push({ phase: opts.phase, concurrency: opts.concurrency });
      return {
        results: specs.map((spec) => ({
          id: spec.id,
          spec,
          status: "ok",
          output: {
            text:
              spec.agent === "plan"
                ? JSON.stringify([
                    { agent: "a", prompt: "pa" },
                    { agent: "b", prompt: "pb", dependsOn: ["a"] },
                    { agent: "c", prompt: "pc" },
                  ])
                : `out-${spec.agent}`,
          },
          startedAt: 1,
          finishedAt: 2,
        })),
        elapsedMs: 1,
      };
    };
    const { runTaskWorkflow } = createBuiltinWorkflows({
      getAdapter: testAdapter,
      runPhase: executePhase,
    });
    await runTaskWorkflow(fakeSession(), "--concurrency 2 do the thing");
    const explore = phaseCalls.filter((call) => call.phase === "explore");
    assert.ok(explore.length >= 2);
    assert.ok(explore.every((call) => call.concurrency === 2));
    assert.equal(phaseCalls.find((call) => call.phase === "plan").concurrency, undefined);
  });
});

test("programmatic scaling options persist for resume", async () => {
  await withTempDataDir(async () => {
    const { runTaskWorkflow } = createBuiltinWorkflows({ getAdapter: testAdapter });
    const run = await runTaskWorkflow(fakeSession(), "do the thing", {
      agents: 3,
      concurrency: 4,
    });
    assert.equal(
      run.manifest.args.task,
      "--agents 3 --concurrency 4 do the thing",
    );
  });
});
```

Also add a test proving invalid options return `null`, log one actionable error,
create no run directory, and never invoke the adapter.

- [ ] **Step 2: Run workflow tests and verify RED**

```bash
node --test tests/builtin-workflows.test.mjs
```

Expected: FAIL because flags remain in task text, planner sizing stays 3–16
automatic, and explore calls do not receive concurrency.

- [ ] **Step 3: Resolve options before side effects**

In `createBuiltinWorkflows`, allow an injected phase runner:

```js
export function createBuiltinWorkflows(deps) {
  const getAdapter = deps.getAdapter;
  const env = deps.env ?? process.env;
  const executePhase = deps.runPhase ?? runPhase;
```

Replace internal `runPhase(...)` calls with `executePhase(...)`.

At the start of `runTaskWorkflow`, parse effective options before the write-mode
repository check:

```js
let taskOptions;
try {
  taskOptions = parseTaskOptions(rawTask, {
    write: opts.write,
    allowDirty: opts.allowDirty,
    agents: opts.agents,
    concurrency: opts.concurrency,
  });
} catch (err) {
  await session.log(`ghcp-maestro: invalid task options: ${err.message}`, {
    level: "error",
  });
  return null;
}
const writeMode = taskOptions.write;
const concurrency = taskOptions.concurrency ?? DEFAULT_CONCURRENCY;
```

Use `taskOptions.task` for file-reference resolution and
`serializeTaskOptions(taskOptions)` for `manifestTask`. Pass
`{ agentCount: taskOptions.agents }` to both initial and retry
`buildPlanPrompt` calls, and pass `agentCount` to both
`parseAndValidatePlan` calls.

Change the startup log to include both controls:

```js
const sizing = taskOptions.agents === undefined ? "auto(3-16)" : taskOptions.agents;
await session.log(
  `ghcp-maestro/${runId}: task "${task.slice(0, 80)}" ` +
    `(adapter=${adapter.name}, agents=${sizing}, concurrency=${concurrency}, dir=${run.runDir})`,
);
```

Pass `concurrency` only to each explore-layer call:

```js
const { results, elapsedMs } = await executePhase(runnable, {
  run,
  runId,
  phase: "explore",
  adapter,
  budget,
  concurrency,
});
```

- [ ] **Step 4: Run workflow and phase tests and verify GREEN**

```bash
node --test tests/builtin-workflows.test.mjs tests/run-phase.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add core/builtin-workflows.mjs tests/builtin-workflows.test.mjs
git commit -m "feat: apply task agent and concurrency controls

Refs #48

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Help, guide, and release notes

**Files:**
- Modify: `core/help.mjs`
- Modify: `extensions/ghcp-maestro/extension.mjs`
- Modify: `tests/help.test.mjs`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `docs/GUIDE.md`
- Modify: `docs/GUIDE.ko.md`
- Modify: `docs/CHANGELOG.md`

**Interfaces:**
- `core/help.mjs` exports `TASK_COMMAND_SUMMARY`.
- `/maestro help` advertises automatic 3–16 sizing and both flags.
- Documentation uses “agents” for total workers and “concurrency” for
  simultaneous workers.

- [ ] **Step 1: Write the failing help assertion**

Import the new production constant and add this assertion to
`tests/help.test.mjs`:

```js
import {
  renderMaestroHelp,
  DIAGNOSTICS_HEADER,
  TASK_COMMAND_SUMMARY,
} from "../core/help.mjs";

test("task help explains agent count and concurrency overrides", () => {
  assert.match(TASK_COMMAND_SUMMARY, /Auto-size 3-16 workers/);
  assert.match(TASK_COMMAND_SUMMARY, /--agents N/);
  assert.match(TASK_COMMAND_SUMMARY, /--concurrency N/);
});
```

- [ ] **Step 2: Run the help test and verify RED**

```bash
node --test tests/help.test.mjs
```

Expected: FAIL because `TASK_COMMAND_SUMMARY` is not exported.

- [ ] **Step 3: Update user-facing copy**

Add the production copy to `core/help.mjs`:

```js
export const TASK_COMMAND_SUMMARY =
  "Auto-size 3-16 workers (override with --agents N), " +
  "run with bounded concurrency (--concurrency N), then synthesize one answer.";
```

Import `TASK_COMMAND_SUMMARY` in `extensions/ghcp-maestro/extension.mjs` and use
it as the task subcommand's `summary`.

Document these examples in both guides:

```text
/maestro task Audit every API route
/maestro task --agents 12 Audit every package independently
/maestro task --agents 30 --concurrency 8 Migrate each independent module
```

Update both READMEs from “3–6 subtasks” to “3–16 automatically sized
subtasks” and add one sentence distinguishing total workers from simultaneous
workers. Add an Unreleased changelog entry referencing #48 and explicitly note
that saved workflow limits remain 16 concurrent / 1,000 per `spawnAll`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node --test tests/help.test.mjs
```

Expected: all help tests pass.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add core/help.mjs extensions/ghcp-maestro/extension.mjs tests/help.test.mjs \
  README.md README.ko.md docs/GUIDE.md docs/GUIDE.ko.md docs/CHANGELOG.md
git commit -m "docs: explain configurable task scaling

Refs #48

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Final verification and review

**Files:**
- Verify all files changed by Tasks 1–4.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Run targeted behavior tests together**

```bash
node --test \
  tests/task-options.test.mjs \
  tests/write-mode.test.mjs \
  tests/plan-parse.test.mjs \
  tests/builtin-workflows.test.mjs \
  tests/run-phase.test.mjs \
  tests/help.test.mjs
```

Expected: all targeted tests pass with zero failures.

- [ ] **Step 2: Run the complete local gate**

```bash
npm run check
```

Expected: ESLint exits 0 and every test passes.

- [ ] **Step 3: Inspect the final diff and issue coverage**

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Expected: no whitespace errors, only issue #48 files changed, and a clean
working tree.

- [ ] **Step 4: Request code review**

Use the repository review workflow to check the branch against issue #48.
Address only credible correctness, security, data-loss, or architecture
findings, with a failing test first for code changes.
