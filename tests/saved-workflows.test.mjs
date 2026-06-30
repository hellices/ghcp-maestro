import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateWorkflowName,
  scanSavedWorkflows,
  loadSavedWorkflow,
  buildWorkflowApi,
  parseWorkflowArgs,
  RESERVED_WORKFLOW_NAMES,
} from "../extensions/ghcp-maestro/runtime/saved-workflows.mjs";

async function tmp() {
  return mkdtemp(join(tmpdir(), "ghcp-maestro-wf-"));
}

// ── validateWorkflowName ────────────────────────────────────────────────────

test("validateWorkflowName accepts kebab-case, rejects junk and reserved", () => {
  assert.equal(validateWorkflowName("deep-review"), null);
  assert.equal(validateWorkflowName("a1"), null);
  assert.match(validateWorkflowName("Bad Name"), /kebab-case/);
  assert.match(validateWorkflowName("UPPER"), /kebab-case/);
  assert.match(validateWorkflowName(""), /empty/);
  assert.match(validateWorkflowName("task"), /reserved/);
  for (const n of RESERVED_WORKFLOW_NAMES) {
    assert.match(validateWorkflowName(n), /reserved/);
  }
});

// ── scanSavedWorkflows ──────────────────────────────────────────────────────

test("scanSavedWorkflows finds .mjs files and ignores others", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "alpha.mjs"), "export default () => {};");
    await writeFile(join(dir, "notes.txt"), "ignore me");
    await writeFile(join(dir, "Bad Name.mjs"), "export default () => {};");
    const { workflows, skipped } = await scanSavedWorkflows([dir]);
    assert.deepEqual(workflows.map((w) => w.name), ["alpha"]);
    assert.equal(skipped.some((s) => /kebab-case/.test(s.reason)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanSavedWorkflows dedups by name, highest-priority dir wins", async () => {
  const high = await tmp();
  const low = await tmp();
  try {
    await writeFile(join(high, "dup.mjs"), "export default () => 'high';");
    await writeFile(join(low, "dup.mjs"), "export default () => 'low';");
    await writeFile(join(low, "only-low.mjs"), "export default () => {};");
    const { workflows, skipped } = await scanSavedWorkflows([high, low]);
    const dup = workflows.find((w) => w.name === "dup");
    assert.equal(dup.dir, high);
    assert.deepEqual(workflows.map((w) => w.name).sort(), ["dup", "only-low"]);
    assert.equal(skipped.some((s) => /shadowed/.test(s.reason)), true);
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("scanSavedWorkflows tolerates missing directories", async () => {
  const { workflows } = await scanSavedWorkflows(["/no/such/dir/ghcp-maestro"]);
  assert.deepEqual(workflows, []);
});

// ── loadSavedWorkflow ───────────────────────────────────────────────────────

test("loadSavedWorkflow imports a valid default-export workflow", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "good.mjs");
    await writeFile(
      file,
      'export const description = "demo";\nexport default async function run(api) { return api.args; }\n',
    );
    const { run, description } = await loadSavedWorkflow(file);
    assert.equal(typeof run, "function");
    assert.equal(description, "demo");
    assert.deepEqual(await run({ args: { x: 1 } }), { x: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSavedWorkflow accepts a named 'run' export", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "named.mjs");
    await writeFile(file, "export async function run() { return 42; }\n");
    const { run } = await loadSavedWorkflow(file);
    assert.equal(await run(), 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSavedWorkflow rejects a module without a runnable export", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "bad.mjs");
    await writeFile(file, "export const nope = 1;\n");
    await assert.rejects(() => loadSavedWorkflow(file), /must default-export/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildWorkflowApi ────────────────────────────────────────────────────────

test("buildWorkflowApi injects bound spawn/quality helpers and args", async () => {
  const logs = [];
  const session = { log: (m) => logs.push(m) };
  const adapter = {
    name: "echo",
    async invoke(spec) {
      return { text: `ran ${spec.agent}` };
    },
  };
  const api = buildWorkflowApi({
    session,
    adapter,
    args: { topic: "hi" },
    namespace: "demo",
  });
  assert.equal(api.args.topic, "hi");
  assert.equal(typeof api.spawnAll, "function");
  assert.equal(typeof api.multiAngle, "function");

  const [res] = await api.spawnAll([{ id: "x", agent: "x", prompt: "p" }]);
  assert.equal(res.status, "ok");
  assert.equal(res.output.text, "ran x");

  const out = await api.phase("p1", async () => 7);
  assert.equal(out, 7);
  assert.equal(logs.some((l) => /phase=p1 start/.test(l)), true);
  assert.equal(logs.some((l) => /phase=p1 done/.test(l)), true);
});

test("buildWorkflowApi requires session.log and adapter", () => {
  assert.throws(() => buildWorkflowApi({ adapter: {} }), /session\.log is required/);
  assert.throws(
    () => buildWorkflowApi({ session: { log() {} } }),
    /adapter is required/,
  );
});

// ── parseWorkflowArgs ───────────────────────────────────────────────────────

test("parseWorkflowArgs handles json, plain text, and empty", () => {
  assert.deepEqual(parseWorkflowArgs('{"topic":"x"}'), { topic: "x" });
  assert.deepEqual(parseWorkflowArgs("just text"), { input: "just text" });
  assert.deepEqual(parseWorkflowArgs("  "), {});
  // invalid JSON falls back to string
  assert.deepEqual(parseWorkflowArgs("{not json"), { input: "{not json" });
});

// ── bundled example ─────────────────────────────────────────────────────────

test("the bundled deep-review example is discoverable and valid", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "extensions", "ghcp-maestro", "saved-workflows");
  const { workflows } = await scanSavedWorkflows([bundled]);
  const dr = workflows.find((w) => w.name === "deep-review");
  assert.ok(dr, "deep-review workflow should be discovered");
  const { run, description } = await loadSavedWorkflow(dr.file);
  assert.equal(typeof run, "function");
  assert.match(description, /\w+/);
});
