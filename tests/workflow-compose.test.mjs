import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseComposeArgs,
  slugifyWorkflowName,
  buildComposePrompt,
  extractWorkflowCode,
  stripLiterals,
  scanForbiddenGlobals,
  dryRunWorkflowCode,
  composeWorkflowCommand,
} from "../core/workflow-compose.mjs";

// ── parseComposeArgs ────────────────────────────────────────────────────────

test("parseComposeArgs splits description, --name, and --force", () => {
  assert.deepEqual(parseComposeArgs("review a PR from 3 angles --name tri-review --force"), {
    description: "review a PR from 3 angles",
    name: "tri-review",
    force: true,
  });
  assert.deepEqual(parseComposeArgs("just a description"), {
    description: "just a description",
    force: false,
  });
  assert.deepEqual(parseComposeArgs("--name solo do things"), {
    description: "do things",
    name: "solo",
    force: false,
  });
  assert.deepEqual(parseComposeArgs(""), { description: "", force: false });
  // --name without a usable value must not swallow the next flag or silently
  // fall back to the slug — an empty name fails validation with a clear warning
  assert.deepEqual(parseComposeArgs("do things --name"), {
    description: "do things",
    name: "",
    force: false,
  });
  assert.deepEqual(parseComposeArgs("do things --name --force"), {
    description: "do things",
    name: "",
    force: true,
  });
});

// ── slugifyWorkflowName ─────────────────────────────────────────────────────

test("slugifyWorkflowName produces valid kebab names", () => {
  assert.equal(slugifyWorkflowName("Review a PR from 3 angles"), "review-a-pr-from-3");
  assert.equal(slugifyWorkflowName("한국어 설명 only symbols !!!"), "only-symbols");
  // a name that starts invalid gets a wf- prefix; empty input still yields a name
  assert.equal(slugifyWorkflowName("!!!"), "wf");
  // reserved names get a suffix instead of colliding with built-ins
  assert.equal(slugifyWorkflowName("task"), "task-wf");
});

// ── extractWorkflowCode ─────────────────────────────────────────────────────

test("extractWorkflowCode takes the largest fenced block", () => {
  const text = [
    "Here you go:",
    "```js",
    "export default async function run(api) { await api.log('hi'); }",
    "```",
    "Notes: `short` inline.",
  ].join("\n");
  assert.match(extractWorkflowCode(text), /^export default async function/);
  // sloppy fences (language tag + trailing space, uppercase, "javascript")
  const sloppy = "```JavaScript \nexport default async function run() {}\n```";
  assert.match(extractWorkflowCode(sloppy), /^export default/);
});

test("extractWorkflowCode accepts a bare module and rejects prose", () => {
  assert.match(extractWorkflowCode("export default async () => {};"), /^export default/);
  assert.match(extractWorkflowCode("/* header */\nexport default async () => {};"), /^\/\* header/);
  assert.throws(() => extractWorkflowCode("I could not produce a script."), /no fenced code block/);
});

// ── stripLiterals / scanForbiddenGlobals ────────────────────────────────────

test("stripLiterals removes strings and comments but keeps template interpolations", () => {
  const code = 'const p = `analyze the process ${process.env.X} carefully`; // process note';
  const stripped = stripLiterals(code);
  assert.equal(/process note/.test(stripped), false, "comments are stripped");
  assert.equal(/analyze the/.test(stripped), false, "template text is stripped");
  assert.match(stripped, /process\.env\.X/);
});

test("scanForbiddenGlobals flags escapes but not prompt text", () => {
  assert.deepEqual(
    scanForbiddenGlobals('const prompt = "review the build process and fetch requirements";'),
    [],
  );
  assert.ok(scanForbiddenGlobals("import fs from 'node:fs';").length > 0);
  assert.ok(scanForbiddenGlobals("const x = await import('node:fs');").length > 0);
  assert.ok(scanForbiddenGlobals("process.exit(1)").length > 0);
  assert.ok(scanForbiddenGlobals("globalThis.fetch('http://x')").length > 0);
  assert.ok(scanForbiddenGlobals("new Function('return 1')()").length > 0);
  assert.ok(scanForbiddenGlobals("console.log('hi')").length > 0);
  // Function reachable via .constructor must be caught too
  assert.ok(scanForbiddenGlobals("(async () => {}).constructor('x')()").length > 0);
  assert.ok(scanForbiddenGlobals("const e = eval; e('1')").length > 0);
  // hidden inside a template interpolation must still be caught
  assert.ok(scanForbiddenGlobals("const p = `${process.env.SECRET}`;").length > 0);
  // `global` is forbidden too — otherwise global['process'] (the string is
  // stripped by the literal walker) would be a trivial bypass
  assert.ok(scanForbiddenGlobals("const p = global['pro' + 'cess'];").length > 0);
  // a `}` inside a regex literal must not close the `${...}` interpolation
  // early and swallow the rest of it
  assert.ok(scanForbiddenGlobals("const x = `${/}/.test(0) && process.exit(1)}`;").length > 0);
  // ...while division stays division and regex patterns stay unscanned
  assert.equal(scanForbiddenGlobals("const y = a / b / c;").length, 0);
  assert.equal(scanForbiddenGlobals("const r = /process/; r.test(s);").length, 0);
  // regex literals after expression-ending keywords are literals too
  assert.equal(scanForbiddenGlobals("function f() { return /process/; }").length, 0);
  assert.equal(scanForbiddenGlobals("if (x) throw /fetch/;").length, 0);
  // a stripped literal leaves a placeholder so a following / stays division —
  // otherwise "a" / process.exit(1) / "b" would be swallowed as a regex
  assert.ok(scanForbiddenGlobals('const z = "a" / process.exit(1) / "b";').length > 0);
});

// ── buildComposePrompt ──────────────────────────────────────────────────────

test("buildComposePrompt fences the description and documents the api", () => {
  const prompt = buildComposePrompt({ description: "do the thing", name: "my-flow" });
  assert.match(prompt, /```\ndo the thing\n```/);
  assert.match(prompt, /api\.spawnAll/);
  assert.match(prompt, /api\.fixLoop/);
  assert.match(prompt, /'my-flow'/);
  assert.match(prompt, /no imports/i);
});

// ── dryRunWorkflowCode ──────────────────────────────────────────────────────

const GOOD_WORKFLOW = [
  'export const description = "test flow";',
  "export default async function run(api) {",
  "  await api.log(`starting with ${JSON.stringify(api.args)}`);",
  '  const results = await api.spawnAll([{ id: "a", agent: "a", prompt: "pa" }, { id: "b", agent: "b", prompt: "pb" }]);',
  '  const ok = results.filter((r) => r.status === "ok");',
  "  await api.log(`done: ${ok.length}/${results.length} ok`);",
  "}",
].join("\n");

test("dryRunWorkflowCode executes a good module against the echo adapter", async () => {
  await dryRunWorkflowCode(GOOD_WORKFLOW);
});

test("dryRunWorkflowCode surfaces a runtime blow-up", async () => {
  const bad = "export default async function run(api) { await api.noSuchMethod(); }";
  await assert.rejects(() => dryRunWorkflowCode(bad), /noSuchMethod/);
});

test("dryRunWorkflowCode times out a module that stalls during evaluation", async () => {
  // module evaluation that stalls (a long-lived timer keeps the loop alive) —
  // the timeout envelope must cover module loading, not just run(api)
  const stalled = "await new Promise((r) => setTimeout(r, 1e9));\nexport default async function run() {}";
  await assert.rejects(() => dryRunWorkflowCode(stalled, { timeoutMs: 500 }), /exceeded 500ms/);
});

test("dryRunWorkflowCode hard-kills a synchronous hang", async () => {
  // while(true) can't be interrupted in-process — the child-process isolation
  // makes the timeout hard (SIGKILL) instead of hanging the host session
  const busy = "export default async function run() { while (true) {} }";
  await assert.rejects(() => dryRunWorkflowCode(busy, { timeoutMs: 500 }), /exceeded 500ms/);
});

// ── composeWorkflowCommand (end-to-end with fakes) ──────────────────────────

function fakeSession({ interactive = true, respond } = {}) {
  const logs = [];
  const session = {
    logs,
    capabilities: interactive ? { ui: { elicitation: true } } : {},
    log: async (msg) => {
      logs.push(String(msg));
    },
  };
  if (interactive) {
    session.ui = {
      async elicitation(params) {
        return respond ? respond(params) : { action: "accept" };
      },
    };
  }
  return session;
}

function plannerAdapter(code) {
  return {
    name: "fake-planner",
    async invoke() {
      return { text: "Here is the workflow:\n```js\n" + code + "\n```" };
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-compose-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("compose saves an approved, validated workflow to the project dir", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession();
    await composeWorkflowCommand(session, "do parallel things --name my-flow", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
    });
    const saved = await readFile(join(dir, "my-flow.mjs"), "utf8");
    assert.equal(saved, GOOD_WORKFLOW);
    assert.ok(session.logs.some((l) => /saved 'my-flow'/.test(l)));
    assert.ok(session.logs.some((l) => /maestro run my-flow/.test(l)));
  });
});

test("compose declining at the review gate saves nothing", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession({ respond: () => ({ action: "decline" }) });
    await composeWorkflowCommand(session, "do things --name my-flow", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
    });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    assert.ok(session.logs.some((l) => /declined at review/.test(l)));
  });
});

test("compose on a non-interactive host writes a draft, never a runnable file", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession({ interactive: false });
    let dryRuns = 0;
    await composeWorkflowCommand(session, "do things --name my-flow", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
      dryRun: async () => {
        dryRuns += 1;
      },
    });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    const draft = await readFile(join(dir, "my-flow.mjs.draft"), "utf8");
    assert.equal(draft, GOOD_WORKFLOW);
    assert.equal(dryRuns, 0, "no code may execute without a human in the loop");
    assert.ok(session.logs.some((l) => /draft written/.test(l)));
  });
});

test("compose never clobbers an existing draft, even with --force", async () => {
  await withTempDir(async (dir) => {
    const manualEdits = "// my manual edits\nexport default async function run() {}";
    await writeFile(join(dir, "my-flow.mjs.draft"), manualEdits, "utf8");
    const session = fakeSession({ interactive: false });
    await composeWorkflowCommand(session, "do things --name my-flow --force", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
    });
    // the hand-edited draft survives; the new draft lands beside it
    assert.equal(await readFile(join(dir, "my-flow.mjs.draft"), "utf8"), manualEdits);
    assert.equal(await readFile(join(dir, "my-flow-2.mjs.draft"), "utf8"), GOOD_WORKFLOW);
  });
});

test("compose rejects generated code that touches forbidden globals", async () => {
  await withTempDir(async (dir) => {
    const evil = "export default async function run(api) { process.exit(1); }";
    const session = fakeSession();
    await composeWorkflowCommand(session, "do things --name my-flow", {
      adapter: plannerAdapter(evil),
      destDir: dir,
    });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    assert.ok(session.logs.some((l) => /forbidden globals/.test(l)));
  });
});

test("compose rejects unparseable generated code before any dialog", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession({
      respond: () => {
        throw new Error("dialog must not open for invalid code");
      },
    });
    await composeWorkflowCommand(session, "do things --name my-flow", {
      adapter: plannerAdapter("export default async function run(api { broken"),
      destDir: dir,
    });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    assert.ok(session.logs.some((l) => /failed validation/.test(l)));
  });
});

test("compose keeps a draft when the post-approval dry run fails", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession();
    await composeWorkflowCommand(session, "do things --name my-flow", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
      dryRun: async () => {
        throw new Error("api misuse at runtime");
      },
    });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    const draft = await readFile(join(dir, "my-flow.mjs.draft"), "utf8");
    assert.equal(draft, GOOD_WORKFLOW);
    assert.ok(session.logs.some((l) => /dry run failed/.test(l) && /draft kept/.test(l)));
  });
});

test("compose refuses to overwrite an existing workflow without --force", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "my-flow.mjs"), "export default async () => {};", "utf8");
    let plannerCalls = 0;
    const adapter = {
      name: "counting",
      async invoke() {
        plannerCalls += 1;
        return { text: "```js\n" + GOOD_WORKFLOW + "\n```" };
      },
    };
    const session = fakeSession();
    await composeWorkflowCommand(session, "do things --name my-flow", { adapter, destDir: dir });
    assert.equal(plannerCalls, 0, "no tokens are spent when the name is taken");
    assert.ok(session.logs.some((l) => /already exists/.test(l)));

    await composeWorkflowCommand(session, "do things --name my-flow --force", {
      adapter,
      destDir: dir,
    });
    assert.equal(plannerCalls, 1);
    const saved = await readFile(join(dir, "my-flow.mjs"), "utf8");
    assert.equal(saved, GOOD_WORKFLOW);
  });
});

test("compose reports a failed planner agent without writing anything", async () => {
  await withTempDir(async (dir) => {
    const adapter = {
      name: "boom",
      async invoke() {
        throw new Error("child session exploded");
      },
    };
    const session = fakeSession();
    await composeWorkflowCommand(session, "do things --name my-flow", { adapter, destDir: dir });
    await assert.rejects(() => access(join(dir, "my-flow.mjs")));
    assert.ok(session.logs.some((l) => /planner agent error/.test(l)));
  });
});

test("compose rejects an invalid --name and requires a description", async () => {
  await withTempDir(async (dir) => {
    const session = fakeSession();
    await composeWorkflowCommand(session, "do things --name Bad_Name", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
    });
    assert.ok(session.logs.some((l) => /cannot use name/.test(l)));

    await composeWorkflowCommand(session, "--force", {
      adapter: plannerAdapter(GOOD_WORKFLOW),
      destDir: dir,
    });
    assert.ok(session.logs.some((l) => /description is required/.test(l)));
  });
});
