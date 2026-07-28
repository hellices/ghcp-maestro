import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseWorkflowSource,
  installWorkflowCommand,
  MAX_WORKFLOW_BYTES,
} from "../core/workflow-install.mjs";

// --- parseWorkflowSource -----------------------------------------------------

test("parseWorkflowSource converts a github blob URL to raw", () => {
  const src = parseWorkflowSource(
    "https://github.com/acme/flows/blob/main/wf/deep-review.mjs",
  );
  assert.equal(src.url, "https://raw.githubusercontent.com/acme/flows/main/wf/deep-review.mjs");
  assert.equal(src.name, "deep-review");
});

test("parseWorkflowSource passes raw.githubusercontent.com URLs through", () => {
  const url = "https://raw.githubusercontent.com/acme/flows/v1.2/wf/audit.mjs";
  const src = parseWorkflowSource(url);
  assert.equal(src.url, url);
  assert.equal(src.name, "audit");
});

test("parseWorkflowSource expands owner/repo/path shorthand (default ref main)", () => {
  const src = parseWorkflowSource("acme/flows/wf/audit.mjs");
  assert.equal(src.url, "https://raw.githubusercontent.com/acme/flows/main/wf/audit.mjs");
  assert.equal(src.name, "audit");
});

test("parseWorkflowSource honours @ref in shorthand", () => {
  const src = parseWorkflowSource("acme/flows/wf/audit.mjs@v2");
  assert.equal(src.url, "https://raw.githubusercontent.com/acme/flows/v2/wf/audit.mjs");
});

test("parseWorkflowSource rejects non-mjs files, foreign hosts, and garbage", () => {
  assert.throws(() => parseWorkflowSource("https://github.com/a/b/blob/main/x.js"), /\.mjs/);
  assert.throws(() => parseWorkflowSource("https://evil.example.com/x.mjs"), /github/i);
  assert.throws(() => parseWorkflowSource("not a source"), /\.mjs|github/i);
  assert.throws(() => parseWorkflowSource(""), /required|empty/i);
});

// --- installWorkflowCommand ---------------------------------------------------

const GOOD_CODE = [
  'export const description = "test workflow";',
  "export default async function run(api) {",
  "  await api.log(\"hi\");",
  "}",
  "",
].join("\n");

function fakeSession({ elicitation } = {}) {
  const logs = [];
  return {
    logs,
    capabilities: elicitation ? { ui: { elicitation: true } } : {},
    ui: elicitation ? { elicitation } : undefined,
    log: async (msg) => {
      logs.push(String(msg));
    },
  };
}

function fetchOk(body) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  });
}

async function withDestDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-install-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("installWorkflowCommand fetches, validates, and writes the workflow", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    const written = await readFile(join(dir, "my-flow.mjs"), "utf8");
    assert.equal(written, GOOD_CODE);
    assert.ok(session.logs.some((l) => /installed .*my-flow/.test(l)));
    assert.ok(session.logs.some((l) => /\/maestro run my-flow/.test(l)));
    // Third-party code warning is always shown.
    assert.ok(session.logs.some((l) => /review/i.test(l)));
  });
});

test("installWorkflowCommand refuses to overwrite without --force", async () => {
  await withDestDir(async (dir) => {
    await writeFile(join(dir, "my-flow.mjs"), "// existing");
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    assert.equal(await readFile(join(dir, "my-flow.mjs"), "utf8"), "// existing");
    assert.ok(session.logs.some((l) => /--force/.test(l)));
  });
});

test("installWorkflowCommand --force overwrites an existing workflow", async () => {
  await withDestDir(async (dir) => {
    await writeFile(join(dir, "my-flow.mjs"), "// existing");
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs --force", {
      destDir: dir,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    assert.equal(await readFile(join(dir, "my-flow.mjs"), "utf8"), GOOD_CODE);
  });
});

test("installWorkflowCommand rejects reserved and invalid workflow names", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/task.mjs", {
      destDir: dir,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    assert.ok(session.logs.some((l) => /reserved/.test(l)));
  });
});

test("installWorkflowCommand rejects oversized workflow files", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk("//" + "x".repeat(MAX_WORKFLOW_BYTES)),
    });
    assert.ok(session.logs.some((l) => /too large|size/i.test(l)));
  });
});

test("installWorkflowCommand rejects modules without a workflow export", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk("const x = 1;\n"),
    });
    assert.ok(session.logs.some((l) => /export/.test(l)));
    await assert.rejects(readFile(join(dir, "my-flow.mjs")));
  });
});

test("installWorkflowCommand rejects files that fail the syntax check", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk("export default function ( {{{ broken\n"),
    });
    assert.ok(session.logs.some((l) => /syntax/i.test(l)));
    await assert.rejects(readFile(join(dir, "my-flow.mjs")));
  });
});

test("installWorkflowCommand surfaces fetch failures", async () => {
  await withDestDir(async (dir) => {
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
    });
    assert.ok(session.logs.some((l) => /404/.test(l)));
  });
});

test("installWorkflowCommand asks for confirmation when elicitation is available", async () => {
  await withDestDir(async (dir) => {
    const calls = [];
    const session = fakeSession({
      elicitation: async (params) => {
        calls.push(params);
        return { action: "decline" };
      },
    });
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: dir,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].message.includes(
        "https://raw.githubusercontent.com/acme/flows/main/wf/my-flow.mjs",
      ),
    );
    await assert.rejects(readFile(join(dir, "my-flow.mjs")));
    assert.ok(session.logs.some((l) => /cancel|declin/i.test(l)));
  });
});

test("installWorkflowCommand creates the destination dir when missing", async () => {
  await withDestDir(async (dir) => {
    const nested = join(dir, "sub", "workflows");
    const session = fakeSession();
    await installWorkflowCommand(session, "acme/flows/wf/my-flow.mjs", {
      destDir: nested,
      fetchImpl: fetchOk(GOOD_CODE),
    });
    assert.equal(await readFile(join(nested, "my-flow.mjs"), "utf8"), GOOD_CODE);
  });
});
