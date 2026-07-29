// Smoke tests for the maestro-top bin: exercise the non-TTY code path end to
// end against a real (temp) run store. The interactive TTY path is covered by
// the pure reducer/renderer tests in tui.test.mjs — here we only assert the
// process-level contract: --all overview, follow-until-terminal, exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun } from "../core/run-store.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../extensions/ghcp-maestro/bin/maestro-top.mjs", import.meta.url));

async function freshBase() {
  return mkdtemp(join(tmpdir(), "ghcp-maestro-bin-"));
}

test("maestro-top --all prints an overview table", async () => {
  const baseDir = await freshBase();
  try {
    const r = await createRun({ workflow: "task", baseDir });
    await r.complete();
    const { stdout } = await run(process.execPath, [BIN, "--all"], {
      env: { ...process.env, GHCP_MAESTRO_DATA_DIR: baseDir },
    });
    assert.match(stdout, /runId · workflow · status/);
    assert.match(stdout, new RegExp(`${r.runId}.*task.*complete`));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("maestro-top follows a terminal run once and exits 0 (non-TTY)", async () => {
  const baseDir = await freshBase();
  try {
    const r = await createRun({ workflow: "task", baseDir });
    await r.writeProgress({
      label: "x", done: 1, total: 1, maxElapsedMs: 1000, totalTokens: 10,
      agents: [{ specId: "a1", agent: "researcher", state: "done", elapsedMs: 1000, bytes: 0, tokens: 10 }],
    });
    await r.complete();
    const { stdout } = await run(process.execPath, [BIN, r.runId], {
      env: { ...process.env, GHCP_MAESTRO_DATA_DIR: baseDir },
    });
    assert.match(stdout, /researcher/);
    assert.match(stdout, /complete/);
    assert.match(stdout, /1\/1 done/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("maestro-top exits non-zero for an unknown run / empty store", async () => {
  const baseDir = await freshBase();
  try {
    await assert.rejects(
      () =>
        run(process.execPath, [BIN, "run-nope"], {
          env: { ...process.env, GHCP_MAESTRO_DATA_DIR: baseDir },
        }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /not found/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        run(process.execPath, [BIN], {
          env: { ...process.env, GHCP_MAESTRO_DATA_DIR: baseDir },
        }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /no runs found/);
        return true;
      },
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
