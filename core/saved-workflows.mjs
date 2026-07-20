// Saved workflows (M5) — discover, validate, and run user/project workflow
// scripts so they can be invoked as slash commands.
//
// A saved workflow is an ESM module that default-exports a function (async, or
// any function returning a Promise — it is always awaited by the runtime):
//
//   // my-workflow.mjs
//   export const description = "One line shown in /maestro workflows";
//   export default async function run(api) {
//     const { args, log, spawnAll, multiAngle } = api;
//     await log(`hello ${args.topic ?? "world"}`);
//   }
//
// Scripts are expected to use only the injected `api` object (see
// buildWorkflowApi) rather than touching the filesystem or shell directly.
// This is a convention, not an enforced sandbox: loadSavedWorkflow uses a
// dynamic import(), so a workflow module's top-level code can still reach Node
// builtins. The trust boundary is the user's own machine — workflows are code
// the user chose to install under their workflows dirs.

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { spawn, spawnAll, DEFAULT_CONCURRENCY } from "./spawn.mjs";
import { runPhase } from "./run-phase.mjs";
import {
  adversarialReview,
  multiAngle,
  fixLoop,
  crossCheck,
} from "./quality.mjs";

/** Names that may not be used by a saved workflow (collide with built-ins). */
export const RESERVED_WORKFLOW_NAMES = new Set([
  "task",
  "hello",
  "brainstorm",
  "pong",
  "echo",
  "help",
  "run",
  "workflows",
  "maestro",
  "maestros",
  "maestro-resume",
  "maestro-stop",
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Validate a workflow name. Returns null if valid, else a reason string. */
export function validateWorkflowName(name) {
  if (typeof name !== "string" || name === "") return "name is empty";
  if (!NAME_RE.test(name)) {
    return "name must be kebab-case (lowercase letters, digits, hyphens; <=40 chars)";
  }
  if (RESERVED_WORKFLOW_NAMES.has(name)) return `'${name}' is a reserved name`;
  return null;
}

/**
 * Default ordered list of directories to scan, highest priority first:
 *   1. project   — $GHCP_MAESTRO_WORKFLOWS_DIR or <cwd>/.ghcp-maestro/workflows
 *   2. user      — <dataDir>/workflows  (defaults to ~/.copilot/plugin-data/...)
 *   3. bundled   — <extensionDir>/saved-workflows  (examples shipped with the plugin)
 *
 * @param {{ cwd?: string, extensionDir?: string, dataDir?: string }} [ctx]
 * @returns {string[]}
 */
export function defaultWorkflowDirs(ctx = {}) {
  const cwd = ctx.cwd ?? process.env.COPILOT_CLI_CWD ?? process.cwd();
  const dataDir =
    ctx.dataDir ??
    process.env.GHCP_MAESTRO_DATA_DIR ??
    join(homedir(), ".copilot", "plugin-data", "ghcp-maestro");
  const dirs = [
    process.env.GHCP_MAESTRO_WORKFLOWS_DIR || join(cwd, ".ghcp-maestro", "workflows"),
    join(dataDir, "workflows"),
  ];
  if (ctx.extensionDir) dirs.push(join(ctx.extensionDir, "saved-workflows"));
  return dirs;
}

/**
 * Scan the given directories (ordered, highest priority first) for `*.mjs`
 * workflow files. Returns deduped descriptors (first occurrence of a name
 * wins) plus a list of skipped files with reasons.
 *
 * @param {string[]} dirs
 * @returns {Promise<{ workflows: Array<{ name: string, file: string, dir: string }>, skipped: Array<{ file: string, reason: string }> }>}
 */
export async function scanSavedWorkflows(dirs) {
  const workflows = [];
  const skipped = [];
  const seen = new Set();

  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      // ENOENT just means the directory doesn't exist. Any other error (e.g.
      // permissions) must only skip THIS directory — never abort the scan, or a
      // single unreadable project/user dir would also hide the bundled
      // workflows and every lower-priority entry.
      if (err?.code !== "ENOENT") {
        skipped.push({ file: dir, reason: `unreadable directory: ${err?.message ?? err}` });
      }
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".mjs")) continue;
      const file = join(dir, entry);
      try {
        const st = await stat(file);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const name = basename(entry, ".mjs");
      const reason = validateWorkflowName(name);
      if (reason) {
        skipped.push({ file, reason });
        continue;
      }
      if (seen.has(name)) {
        skipped.push({ file, reason: `shadowed by higher-priority '${name}'` });
        continue;
      }
      seen.add(name);
      workflows.push({ name, file, dir });
    }
  }
  return { workflows, skipped };
}

/**
 * Import a saved-workflow module and validate its shape.
 *
 * @param {string} file Absolute path to the workflow .mjs file.
 * @returns {Promise<{ run: Function, description: string }>}
 */
export async function loadSavedWorkflow(file) {
  const mod = await import(pathToFileURL(file).href);
  const run = typeof mod.default === "function"
    ? mod.default
    : typeof mod.run === "function"
      ? mod.run
      : null;
  if (!run) {
    throw new Error(
      `workflow ${basename(file)} must default-export (or export 'run') a function`,
    );
  }
  const description =
    typeof mod.description === "string" ? mod.description : "(no description)";
  return { run, description };
}

/**
 * Build the sandboxed API object injected into a saved workflow. The script
 * gets pre-bound spawn/spawnAll (adapter + runHandle already wired), a
 * monitored `runPhase`, plus the quality helpers, a `phase` grouper, structured
 * `args`, and `log`.
 *
 * @param {{
 *   session: { log: Function },
 *   adapter: import("./spawn.mjs").SubagentAdapter,
 *   run?: object,
 *   args?: unknown,
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   namespace?: string,
 * }} deps
 */
export function buildWorkflowApi(deps) {
  const {
    session,
    adapter,
    run,
    args = {},
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    namespace = "workflow",
  } = deps;
  if (!session?.log) throw new TypeError("buildWorkflowApi: session.log is required");
  if (!adapter) throw new TypeError("buildWorkflowApi: adapter is required");

  const base = { adapter, concurrency, signal, runHandle: run };
  const log = (msg, opts) => session.log(`ghcp-maestro/${namespace}: ${msg}`, opts);

  return {
    args,
    log,
    concurrency,
    signal,
    adapter,
    run,
    spawn: (spec) => spawn(spec, base),
    spawnAll: (specs, extra) => spawnAll(specs, { ...base, ...(extra || {}) }),
    /**
     * Run a named phase through the same monitor+spawnAll+settle+flush
     * choreography the built-in workflows use, so a saved workflow's fan-outs
     * show up in /maestros progress just like `task`/`brainstorm`. Returns
     * `{ results, elapsedMs }`. Requires a run handle (always present here).
     */
    runPhase: (name, specs) =>
      runPhase(specs, {
        run,
        runId: run?.runId ?? namespace,
        phase: name,
        adapter,
        concurrency,
        signal,
      }),
    async phase(name, fn) {
      await log(`phase=${name} start`);
      const t0 = Date.now();
      try {
        const result = await fn();
        await log(`phase=${name} done in ${Date.now() - t0}ms`);
        return result;
      } catch (err) {
        await log(`phase=${name} failed in ${Date.now() - t0}ms: ${err?.message ?? err}`, {
          level: "error",
        });
        throw err;
      }
    },
    adversarialReview: (findings, extra) =>
      adversarialReview(findings, { ...base, ...(extra || {}) }),
    multiAngle: (task, extra) => multiAngle(task, { ...base, ...(extra || {}) }),
    fixLoop: (opts) => fixLoop({ ...base, ...(opts || {}) }),
    crossCheck: (claims, extra) => crossCheck(claims, { ...base, ...(extra || {}) }),
  };
}

/**
 * Split a `<name> [args]` invocation string (e.g. from `/maestro run`) into the
 * workflow name and the raw argument remainder. Shared by the CLI and VS Code
 * surfaces so the parsing can't drift.
 *
 * @param {string} [raw] - may be undefined/empty; treated as ""
 * @returns {{ name: string, rest: string }}
 */
export function splitWorkflowInvocation(raw) {
  const trimmed = (raw ?? "").trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { name: trimmed, rest: "" };
  return { name: trimmed.slice(0, spaceIdx), rest: trimmed.slice(spaceIdx + 1).trim() };
}

/**
 * Parse the raw argument string passed after a workflow name. If it looks like
 * JSON (`{...}`) it is parsed as structured args; otherwise it is wrapped as
 * `{ input: <string> }` for convenience.
 *
 * @param {string} [raw] - may be undefined/empty; treated as ""
 * @returns {object}
 */
export function parseWorkflowArgs(raw) {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      // Defensive: only return plain objects so the documented object-only
      // contract holds. `typeof [] === "object"` too, so exclude arrays even
      // though a `{`-prefixed string can't currently parse into one.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to treating it as a plain string
    }
  }
  return { input: trimmed };
}
