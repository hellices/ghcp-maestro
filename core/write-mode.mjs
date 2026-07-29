// Write mode (#40) — opt-in worktree-per-agent isolation so /maestro task can
// safely run repo-modifying subtasks (migration sweeps, batch refactoring) in
// parallel.
//
// Industry consensus this implements: no mainstream tool lets parallel agents
// write to the same checkout. The local-CLI pattern is worktree-per-agent
// (`git worktree add` → one branch per agent → independent writes → sequential
// integration with tests after each merge). Semantic conflicts cannot be
// auto-detected by anyone — the only documented mitigation is sequential merge
// plus a check command, which is exactly what integrateBranches does.
//
// All git access goes through an injectable `exec` so tests never touch a real
// repository. Flag parsing and scope validation are pure.

import { execFile, exec as execShell } from "node:child_process";
import { join } from "node:path";

/** Flags recognized anywhere in the /maestro task line. */
export const WRITE_FLAG = "--write";
export const ALLOW_DIRTY_FLAG = "--allow-dirty";

/**
 * Extract write-mode flags from a raw task line. Pure. Unknown `--` tokens are
 * left in the text (they may be part of the task itself, e.g. a CLI flag the
 * user is asking about).
 *
 * @param {string} raw
 * @returns {{ write: boolean, allowDirty: boolean, task: string }}
 */
export function parseWriteFlags(raw) {
  let write = false;
  let allowDirty = false;
  const rest = [];
  for (const token of String(raw ?? "").split(/\s+/)) {
    if (token === WRITE_FLAG) write = true;
    else if (token === ALLOW_DIRTY_FLAG) allowDirty = true;
    else if (token.length > 0) rest.push(token);
  }
  return { write, allowDirty, task: rest.join(" ") };
}

/**
 * Default exec: run `git <args>` and resolve with collected output. Rejection
 * carries stderr so callers can surface actionable git errors.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function execGit(args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr?.trim() || err.message}`));
        } else {
          resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}

/**
 * Verify the cwd is inside a git work tree and (unless allowDirty) that the
 * tree is clean. Throws with an actionable message otherwise. Returns the
 * current branch name so integration knows where to merge back.
 *
 * @param {{ exec?: typeof execGit, cwd?: string, allowDirty?: boolean }} [opts]
 * @returns {Promise<{ branch: string }>}
 */
export async function assertWritableRepo(opts = {}) {
  const exec = opts.exec ?? execGit;
  const cwd = opts.cwd;
  try {
    await exec(["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    throw new Error("write mode requires a git repository — not inside a git work tree");
  }
  if (!opts.allowDirty) {
    const { stdout } = await exec(["status", "--porcelain"], { cwd });
    if (stdout.trim() !== "") {
      throw new Error(
        `write mode requires a clean work tree (commit or stash first, or pass ${ALLOW_DIRTY_FLAG})`,
      );
    }
  }
  const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("write mode requires a checked-out branch (detached HEAD is not supported)");
  }
  return { branch };
}

/**
 * Normalize and validate the `files` scopes of a write-mode plan: every
 * subtask must declare at least one relative path prefix, and no two subtasks
 * may claim overlapping prefixes (equal, or one containing the other) — the
 * same-file-overwrite hazard is the top documented failure mode of parallel
 * write agents. Throws a human-readable Error the planner can retry against.
 *
 * @param {{ agent: string, files?: string[] }[]} specs
 */
export function validateDisjointScopes(specs) {
  const claims = [];
  for (const spec of specs) {
    const files = spec.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(
        `write mode: subtask "${spec.agent}" must declare a non-empty "files" scope array`,
      );
    }
    for (const rawPath of files) {
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        throw new Error(`write mode: subtask "${spec.agent}" has an empty "files" entry`);
      }
      const path = normalizeScopePath(rawPath);
      if (path === null) {
        throw new Error(
          `write mode: subtask "${spec.agent}" scope "${rawPath}" must be a relative path without ".."`,
        );
      }
      claims.push({ agent: spec.agent, path });
    }
  }
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i];
      const b = claims[j];
      if (a.agent === b.agent) continue;
      if (scopesOverlap(a.path, b.path)) {
        throw new Error(
          `write mode: overlapping file scopes — "${a.agent}" claims "${a.path}" and "${b.agent}" claims "${b.path}"; no two subtasks may modify the same files`,
        );
      }
    }
  }
}

/** @returns {string | null} normalized relative path, or null when invalid */
function normalizeScopePath(rawPath) {
  let path = rawPath.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "" || path === ".") return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  if (path.split("/").includes("..")) return null;
  return path;
}

function scopesOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Create one worktree + branch per agent under `root`. Branch names are
 * `maestro/<runId>/<agent>`. If the branch already exists (resume), the
 * worktree is attached to it instead of failing.
 *
 * @param {{ agent: string }[]} specs
 * @param {{ exec?: typeof execGit, cwd?: string, root: string, runId: string }} opts
 * @returns {Promise<{ agent: string, dir: string, branch: string }[]>}
 */
export async function createWorktrees(specs, opts) {
  const exec = opts.exec ?? execGit;
  const created = [];
  for (const spec of specs) {
    const branch = `maestro/${opts.runId}/${spec.agent}`;
    const dir = join(opts.root, spec.agent);
    try {
      await exec(["worktree", "add", dir, "-b", branch], { cwd: opts.cwd });
    } catch (err) {
      // Resume path: the branch survives from the previous attempt — reattach.
      if (/already exists/i.test(err?.message ?? "")) {
        await exec(["worktree", "add", dir, branch], { cwd: opts.cwd });
      } else {
        throw err;
      }
    }
    created.push({ agent: spec.agent, dir, branch });
  }
  return created;
}

/**
 * Prefix a subtask prompt with the write-mode working contract: work only in
 * the agent's own worktree, touch only the declared scope, commit the result.
 *
 * @param {string} prompt
 * @param {{ dir: string, branch: string, files: string[] }} worktree
 * @returns {string}
 */
export function buildWritePrompt(prompt, worktree) {
  return [
    "WRITE MODE — working contract (violating it corrupts parallel work):",
    `- Do ALL work inside this directory and nowhere else: ${worktree.dir}`,
    `- You are on git branch ${worktree.branch}; do not switch branches.`,
    `- Modify ONLY files under: ${worktree.files.join(", ")}`,
    "- When done, stage and commit every change (git add + git commit) with a concise message. Uncommitted work is discarded.",
    "",
    prompt,
  ].join("\n");
}

/**
 * Build an async check runner from a user-provided shell command (e.g.
 * `npm test`). Runs in `cwd`, throws with a bounded output preview on failure.
 *
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {() => Promise<void>}
 */
export function makeCheckRunner(cmd, cwd) {
  return () =>
    new Promise((resolvePromise, reject) => {
      execShell(cmd, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const preview = String(stderr || stdout || err.message)
            .trim()
            .slice(0, 400);
          reject(new Error(`"${cmd}" failed: ${preview}`));
        } else {
          resolvePromise();
        }
      });
    });
}

/**
 * Sequentially merge agent branches back into `targetBranch`, optionally
 * running a check command after each merge. Stops on the first conflict or
 * check failure, leaving remaining branches for manual integration — the
 * documented mitigation for semantic conflicts nobody can auto-detect.
 *
 * `runCheck` is an injectable async () => void that throws on failure.
 *
 * @param {{ agent: string, branch: string }[]} branches
 * @param {{ exec?: typeof execGit, cwd?: string, targetBranch: string, runCheck?: () => Promise<void>, log?: (msg: string, opts?: object) => unknown }} opts
 * @returns {Promise<{ merged: string[], failed: { agent: string, branch: string, reason: string } | null, remaining: string[] }>}
 */
export async function integrateBranches(branches, opts) {
  const exec = opts.exec ?? execGit;
  const cwd = opts.cwd;
  const merged = [];
  for (let i = 0; i < branches.length; i += 1) {
    const { agent, branch } = branches[i];
    try {
      await exec(
        ["merge", "--no-ff", branch, "-m", `maestro: integrate ${agent} (${branch})`],
        { cwd },
      );
    } catch (err) {
      // Leave the tree usable: a conflicted merge must not stay half-applied.
      try {
        await exec(["merge", "--abort"], { cwd });
      } catch {
        // No merge in progress (e.g. the merge failed before starting) — fine.
      }
      return {
        merged,
        failed: { agent, branch, reason: `merge conflict: ${err?.message ?? err}` },
        remaining: branches.slice(i + 1).map((b) => b.branch),
      };
    }
    if (opts.runCheck) {
      try {
        await opts.runCheck();
      } catch (err) {
        return {
          merged,
          failed: { agent, branch, reason: `check failed after merge: ${err?.message ?? err}` },
          remaining: branches.slice(i + 1).map((b) => b.branch),
        };
      }
    }
    merged.push(branch);
    await opts.log?.(`integrated ${agent} (${branch})${opts.runCheck ? " — check passed" : ""}`);
  }
  return { merged, failed: null, remaining: [] };
}

/**
 * Remove worktrees that are clean; keep (and report) any with uncommitted
 * work — never destroy unmerged agent output. Branches are always kept.
 *
 * @param {{ agent: string, dir: string }[]} worktrees
 * @param {{ exec?: typeof execGit, cwd?: string }} [opts]
 * @returns {Promise<{ removed: string[], kept: { agent: string, dir: string, reason: string }[] }>}
 */
export async function cleanupWorktrees(worktrees, opts = {}) {
  const exec = opts.exec ?? execGit;
  const removed = [];
  const kept = [];
  for (const wt of worktrees) {
    let dirty = false;
    try {
      const { stdout } = await exec(["-C", wt.dir, "status", "--porcelain"], { cwd: opts.cwd });
      dirty = stdout.trim() !== "";
    } catch {
      // Worktree directory already gone — nothing to remove.
      continue;
    }
    if (dirty) {
      kept.push({ agent: wt.agent, dir: wt.dir, reason: "uncommitted changes" });
      continue;
    }
    try {
      await exec(["worktree", "remove", wt.dir], { cwd: opts.cwd });
      removed.push(wt.dir);
    } catch (err) {
      kept.push({ agent: wt.agent, dir: wt.dir, reason: `worktree remove failed: ${err?.message ?? err}` });
    }
  }
  return { removed, kept };
}
