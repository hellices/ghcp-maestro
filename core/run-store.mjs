// Run store — persistence layer for workflow runs.
//
// Each workflow execution is a "run" with a unique `runId`. The store keeps
// the run's manifest, per-phase state, and per-agent input/result caches on
// disk so a run can be inspected, listed, and (in M3.2+) resumed.
//
// Disk layout (defaults to ~/.copilot/plugin-data/ghcp-maestro/runs/<runId>/):
//   manifest.json              — workflow name, args, status, timestamps
//   agents/<agentId>.json      — { spec, status, output|error, startedAt, finishedAt }
//   logs/<agentId>.ndjson      — append-only per-agent event stream (one JSON
//                                object per line: ts + normalized progress
//                                fields) consumed by the maestro-top viewer
//
// All writes go through writeJsonAtomic (write to .tmp → rename) so a crash
// mid-write never leaves a partial file. Reads tolerate missing files and
// return undefined; corrupt JSON throws.

import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

/** Default base directory for all ghcp-maestro run state. */
export function defaultBaseDir() {
  if (process.env.GHCP_MAESTRO_DATA_DIR) return process.env.GHCP_MAESTRO_DATA_DIR;
  return join(homedir(), ".copilot", "plugin-data", "ghcp-maestro");
}

/** Generate a new run id: `run-<base36 ms>-<6 char random>`. */
export function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reject a runId that could escape the runs/ directory. `openRun` is the
 * /maestro-resume entry point, so its runId is user-supplied and must never be
 * joined into a path without this check (path traversal).
 * @param {string} runId
 */
function assertSafeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("openRun: runId must be a non-empty string");
  }
  if (/[/\\]/.test(runId) || runId.includes("..") || runId.includes("\0")) {
    throw new Error(`openRun: unsafe runId ${JSON.stringify(runId)}`);
  }
}

/**
 * Agent ids come from planner output; never join one into a path unchecked.
 * @param {string} agentId
 */
function assertSafeAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("agent events: agentId must be a non-empty string");
  }
  if (/[/\\]/.test(agentId) || agentId.includes("..") || agentId.includes("\0")) {
    throw new Error(`agent events: unsafe agentId ${JSON.stringify(agentId)}`);
  }
}

/**
 * Create a fresh run on disk. Returns a RunHandle that can record agents
 * and update status. Idempotent if the dir already exists.
 *
 * @param {{ workflow: string, args?: unknown, baseDir?: string, runId?: string }} opts
 */
export async function createRun(opts) {
  if (!opts?.workflow) throw new TypeError("createRun: workflow is required");
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const runId = opts.runId ?? newRunId();
  const runDir = join(baseDir, "runs", runId);
  await mkdir(join(runDir, "agents"), { recursive: true });
  const manifest = {
    runId,
    workflow: opts.workflow,
    args: opts.args ?? null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
  };
  await writeJsonAtomic(join(runDir, "manifest.json"), manifest);
  return makeHandle(runDir, manifest);
}

/**
 * Open an existing run by id. Used by /maestro-resume.
 *
 * @param {string} runId
 * @param {{ baseDir?: string }} [opts]
 */
export async function openRun(runId, opts = {}) {
  assertSafeRunId(runId);
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const runDir = join(baseDir, "runs", runId);
  const manifest = await readJson(join(runDir, "manifest.json"));
  if (!manifest) throw new Error(`openRun: no manifest at ${runDir}`);
  return makeHandle(runDir, manifest);
}

/**
 * List runs known to the store, newest first. Each entry is the manifest.
 *
 * @param {{ baseDir?: string, limit?: number }} [opts]
 */
export async function listRuns(opts = {}) {
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const runsRoot = join(baseDir, "runs");
  let entries;
  try {
    entries = await readdir(runsRoot);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const manifests = [];
  for (const id of entries) {
    const m = await readJson(join(runsRoot, id, "manifest.json"));
    if (m) manifests.push(m);
  }
  manifests.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (opts.limit && manifests.length > opts.limit) {
    return manifests.slice(0, opts.limit);
  }
  return manifests;
}

/**
 * Read a run's progress snapshot by id without opening its manifest.
 * Path-safe; returns undefined when the run or its progress.json is missing.
 *
 * @param {string} runId
 * @param {{ baseDir?: string }} [opts]
 */
export async function readRunProgress(runId, opts = {}) {
  assertSafeRunId(runId);
  const baseDir = opts.baseDir ?? defaultBaseDir();
  return readJson(join(baseDir, "runs", runId, "progress.json"));
}

function makeHandle(runDir, manifest) {
  /**
   * @typedef {Object} AgentRecord
   * @property {string} agentId
   * @property {unknown} spec
   * @property {"ok"|"error"|"timeout"|"aborted"|"skipped"} status - "skipped"
   *   is written by workflows for dependents of a failed/deselected dependency
   *   (never produced by spawn itself); like every non-ok status it reruns on
   *   resume.
   * @property {unknown} [output]
   * @property {string} [error]
   * @property {number} startedAt
   * @property {number} finishedAt
   */

  // Serializes progress.json writes for this run. The monitor's render sink
  // fires writeProgress() fire-and-forget, so the terminal burst (settle×N then
  // flush) issues several un-awaited writes to the same file. Atomic renames
  // never corrupt it, but their completion order is not guaranteed — without
  // this chain an earlier "1/3 done" snapshot could land after the final
  // "3/3 done" flush and leave a permanently stale dashboard. Chaining makes
  // issue order == completion order, so the last-issued snapshot always wins.
  let progressWriteChain = Promise.resolve();

  return {
    runId: manifest.runId,
    runDir,
    manifest,

    /** Persist an agent result. Atomic. */
    async writeAgent(record) {
      if (!record?.agentId) throw new TypeError("writeAgent: agentId required");
      await writeJsonAtomic(join(runDir, "agents", `${record.agentId}.json`), record);
    },

    /** Look up a previously cached agent result. Returns undefined if missing. */
    async readAgent(agentId) {
      return readJson(join(runDir, "agents", `${agentId}.json`));
    },

    /**
     * Append one normalized progress event to the agent's ndjson stream
     * (`logs/<agentId>.ndjson`). One JSON object per line, stamped with `ts`.
     * Append-only so the viewer can tail it cheaply; best-effort callers
     * should .catch() — event logging must never fail a run.
     */
    async appendAgentEvent(agentId, event) {
      assertSafeAgentId(agentId);
      const dir = join(runDir, "logs");
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({ ts: Date.now(), ...event });
      await appendFile(join(dir, `${agentId}.ndjson`), line + "\n", "utf8");
    },

    /**
     * Read an agent's event stream, oldest first. Tolerates a torn last line
     * (a crash mid-append) by skipping unparseable lines. `limit` keeps only
     * the most recent N events. Only the trailing `maxBytes` of the file are
     * read and parsed (default 256 KiB) so tailing a long-running agent's log
     * stays cheap; when the window starts mid-file, the partial first line is
     * discarded. Missing file → [].
     *
     * @param {string} agentId
     * @param {{ limit?: number, maxBytes?: number }} [opts]
     * @returns {Promise<object[]>}
     */
    async readAgentEvents(agentId, opts = {}) {
      assertSafeAgentId(agentId);
      const maxBytes = opts.maxBytes ?? 256 * 1024;
      let raw;
      let truncatedHead = false;
      let fh;
      try {
        fh = await open(join(runDir, "logs", `${agentId}.ndjson`), "r");
        const { size } = await fh.stat();
        const start = Math.max(0, size - maxBytes);
        truncatedHead = start > 0;
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        raw = buf.toString("utf8");
      } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
      } finally {
        await fh?.close();
      }
      // a window starting mid-file almost always begins mid-line — drop it
      if (truncatedHead) {
        const nl = raw.indexOf("\n");
        raw = nl === -1 ? "" : raw.slice(nl + 1);
      }
      const events = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // torn/partial line (crash mid-append) — skip
        }
      }
      if (opts.limit && events.length > opts.limit) return events.slice(-opts.limit);
      return events;
    },

    /** Persist the live progress snapshot. Atomic, serialized, best-effort. */
    writeProgress(snapshot) {
      // Wait for the previous write to settle (ignoring its outcome so one
      // failure can't break the chain), then write. The returned promise
      // rejects only for *this* write, so the caller's own .catch still sees it.
      const next = progressWriteChain
        .catch(() => {})
        .then(() => writeJsonAtomic(join(runDir, "progress.json"), snapshot));
      progressWriteChain = next;
      return next;
    },

    /** Read the last persisted progress snapshot, or undefined if none. */
    async readProgress() {
      return readJson(join(runDir, "progress.json"));
    },

    /** Enumerate all cached agent results. */
    async listAgents() {
      const dir = join(runDir, "agents");
      let entries;
      try {
        entries = await readdir(dir);
      } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
      }
      const out = [];
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const rec = await readJson(join(dir, name));
        if (rec) out.push(rec);
      }
      return out;
    },

    /** Update top-level manifest fields. Atomic. */
    async patchManifest(patch) {
      Object.assign(manifest, patch);
      await writeJsonAtomic(join(runDir, "manifest.json"), manifest);
    },

    /** Mark the run as complete. */
    async complete(status = "complete") {
      await this.patchManifest({ status, finishedAt: Date.now() });
    },

    /** Delete the run dir; primarily for tests. */
    async destroy() {
      await rm(runDir, { recursive: true, force: true });
    },
  };
}

// --- IO helpers --------------------------------------------------------------

export async function writeJsonAtomic(filePath, value) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Write into an OS-created unique temp directory (mkdtemp is atomic and uses
  // secure randomness), then atomically rename into place. This avoids any
  // predictable / hand-rolled temp filename and the symlink race that comes with
  // it. The temp dir is a sibling of the target so the rename stays on one
  // filesystem; its ".tmp-" name is never picked up by the run/agent scans
  // (listRuns reads one level up; listAgents filters for ".json").
  const tmpDir = await mkdtemp(join(dir, ".tmp-"));
  const tmp = join(tmpDir, basename(filePath));
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, filePath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
