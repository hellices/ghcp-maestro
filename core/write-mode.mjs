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
  } catch (err) {
    // Keep the friendly wording but preserve git's own diagnostics — "git not
    // found" or a permission error must not masquerade as "not a repo".
    throw new Error(
      `write mode requires a git repository — not inside a git work tree (${err?.message ?? err})`,
    );
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
  const path = rawPath.trim().replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  // Segment-wise normalization: collapse repeated slashes and "." segments so
  // variants like "src//a" or "src/./a" cannot slip past the overlap check.
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.includes("..")) return null;
  return segments.join("/");
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
    let fresh = true;
    try {
      await exec(["worktree", "add", dir, "-b", branch], { cwd: opts.cwd });
    } catch (err) {
      // Resume path: the branch survives from the previous attempt — reattach.
      if (/already exists/i.test(err?.message ?? "")) {
        fresh = false;
        try {
          await exec(["worktree", "add", dir, branch], { cwd: opts.cwd });
        } catch (err2) {
          // The worktree directory itself may also survive (worktrees are
          // kept on purpose when integration stops). Reuse it when it is
          // already checked out on the expected branch.
          const reusable =
            /already exists/i.test(err2?.message ?? "") &&
            (await isWorktreeOnBranch(exec, dir, branch, opts.cwd));
          if (!reusable) {
            await rollbackWorktrees(exec, created, opts.cwd);
            throw err2;
          }
        }
      } else {
        // Roll back the fresh worktrees added so far — a partial set must not
        // fan out, and stray worktrees would need manual cleanup otherwise.
        await rollbackWorktrees(exec, created, opts.cwd);
        throw err;
      }
    }
    created.push({ agent: spec.agent, dir, branch, fresh });
  }
  return created.map(({ agent, dir, branch }) => ({ agent, dir, branch }));
}

/** True when `dir` is an existing worktree already checked out on `branch`. */
async function isWorktreeOnBranch(exec, dir, branch, cwd) {
  try {
    const { stdout } = await exec(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

/**
 * Best-effort removal of just-created worktrees. A branch is deleted only
 * when this run created it (`fresh`) — resume branches carry prior run state
 * and must always survive.
 */
async function rollbackWorktrees(exec, created, cwd) {
  for (const wt of created) {
    try {
      await exec(["worktree", "remove", wt.dir], { cwd });
      if (wt.fresh) await exec(["branch", "-D", wt.branch], { cwd });
    } catch {
      // Rollback is best-effort — the original error is what matters.
    }
  }
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
    "- When done, stage and commit every change (git add + git commit) with a concise message. Only committed work is integrated — uncommitted changes are left behind in the worktree and never merged.",
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
 * @returns {Promise<{ merged: string[], failed: { agent: string, branch: string, reason: string, applied: boolean } | null, remaining: string[] }>}
 */
export async function integrateBranches(branches, opts) {
  const exec = opts.exec ?? execGit;
  const cwd = opts.cwd;
  // Guard against the user having switched branches while agents ran — the
  // merges must land on the branch recorded at run start, not wherever HEAD
  // happens to be now.
  const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const head = stdout.trim();
  if (head !== opts.targetBranch) {
    throw new Error(
      `integration expected branch "${opts.targetBranch}" but HEAD is on "${head}" — check out ${opts.targetBranch} and resume`,
    );
  }
  const merged = [];
  for (let i = 0; i < branches.length; i += 1) {
    const { agent, branch } = branches[i];
    try {
      await exec(
        [
          "merge",
          "--no-ff",
          "-m",
          `maestro: integrate ${agent} (${branch}) into ${opts.targetBranch}`,
          branch,
        ],
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
        failed: { agent, branch, reason: `merge conflict: ${err?.message ?? err}`, applied: false },
        remaining: branches.slice(i + 1).map((b) => b.branch),
      };
    }
    if (opts.runCheck) {
      try {
        await opts.runCheck();
      } catch (err) {
        // The merge itself succeeded — it stays applied so the user can
        // inspect (or revert) the exact failing state. `applied: true` lets
        // callers word their report accordingly.
        return {
          merged,
          failed: {
            agent,
            branch,
            reason: `check failed after merge: ${err?.message ?? err}`,
            applied: true,
          },
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
    } catch (err) {
      // Only a missing directory means "nothing to remove" — any other status
      // failure (permissions, git broken) must be surfaced, not swallowed.
      const msg = String(err?.message ?? err);
      if (/cannot change to|no such file or directory|enoent/i.test(msg)) continue;
      kept.push({ agent: wt.agent, dir: wt.dir, reason: `status failed: ${msg}` });
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
