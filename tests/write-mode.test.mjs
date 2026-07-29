// Unit tests for core/write-mode.mjs (#40) — worktree-per-agent isolation.
// All git access goes through a fake exec; no test touches a real repository.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  parseWriteFlags,
  assertWritableRepo,
  validateDisjointScopes,
  createWorktrees,
  buildWritePrompt,
  integrateBranches,
  cleanupWorktrees,
} from "../core/write-mode.mjs";

// --- parseWriteFlags --------------------------------------------------------

test("parseWriteFlags extracts --write and --allow-dirty from anywhere in the line", () => {
  assert.deepEqual(parseWriteFlags("--write migrate the client"), {
    write: true,
    allowDirty: false,
    task: "migrate the client",
  });
  assert.deepEqual(parseWriteFlags("migrate the client --write --allow-dirty"), {
    write: true,
    allowDirty: true,
    task: "migrate the client",
  });
});

test("parseWriteFlags leaves unknown -- tokens and plain text untouched", () => {
  assert.deepEqual(parseWriteFlags("explain what --force does in git push"), {
    write: false,
    allowDirty: false,
    task: "explain what --force does in git push",
  });
});

test("parseWriteFlags tolerates empty/nullish input", () => {
  assert.deepEqual(parseWriteFlags(""), { write: false, allowDirty: false, task: "" });
  assert.deepEqual(parseWriteFlags(undefined), { write: false, allowDirty: false, task: "" });
});

// --- assertWritableRepo -----------------------------------------------------

function fakeGit(responses) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    for (const [pattern, response] of responses) {
      if (key.startsWith(pattern)) {
        if (response instanceof Error) throw response;
        return typeof response === "string" ? { stdout: response, stderr: "" } : response;
      }
    }
    return { stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

test("assertWritableRepo returns the current branch on a clean repo", async () => {
  const exec = fakeGit([
    ["rev-parse --is-inside-work-tree", "true\n"],
    ["status --porcelain", ""],
    ["rev-parse --abbrev-ref HEAD", "main\n"],
  ]);
  assert.deepEqual(await assertWritableRepo({ exec }), { branch: "main" });
});

test("assertWritableRepo rejects outside a git work tree", async () => {
  const exec = fakeGit([["rev-parse --is-inside-work-tree", new Error("not a git repo")]]);
  await assert.rejects(() => assertWritableRepo({ exec }), /not inside a git work tree/);
});

test("assertWritableRepo rejects a dirty tree unless allowDirty", async () => {
  const responses = [
    ["rev-parse --is-inside-work-tree", "true\n"],
    ["status --porcelain", " M core/foo.mjs\n"],
    ["rev-parse --abbrev-ref HEAD", "main\n"],
  ];
  await assert.rejects(
    () => assertWritableRepo({ exec: fakeGit(responses) }),
    /clean work tree.*--allow-dirty/s,
  );
  assert.deepEqual(await assertWritableRepo({ exec: fakeGit(responses), allowDirty: true }), {
    branch: "main",
  });
});

test("assertWritableRepo rejects detached HEAD", async () => {
  const exec = fakeGit([
    ["rev-parse --is-inside-work-tree", "true\n"],
    ["status --porcelain", ""],
    ["rev-parse --abbrev-ref HEAD", "HEAD\n"],
  ]);
  await assert.rejects(() => assertWritableRepo({ exec }), /detached HEAD/);
});

// --- validateDisjointScopes -------------------------------------------------

test("validateDisjointScopes accepts disjoint file and directory scopes", () => {
  validateDisjointScopes([
    { agent: "a", files: ["src/api/"] },
    { agent: "b", files: ["src/ui", "docs/ui.md"] },
    { agent: "c", files: ["./tests/api.test.mjs"] },
  ]);
});

test("validateDisjointScopes rejects a missing or empty scope", () => {
  assert.throws(() => validateDisjointScopes([{ agent: "a" }]), /non-empty "files" scope/);
  assert.throws(
    () => validateDisjointScopes([{ agent: "a", files: [] }]),
    /non-empty "files" scope/,
  );
});

test("validateDisjointScopes rejects equal scopes across subtasks", () => {
  assert.throws(
    () =>
      validateDisjointScopes([
        { agent: "a", files: ["src/shared.mjs"] },
        { agent: "b", files: ["src/shared.mjs"] },
      ]),
    /overlapping file scopes.*"a".*"b"/s,
  );
});

test("validateDisjointScopes rejects prefix containment (dir vs file inside it)", () => {
  assert.throws(
    () =>
      validateDisjointScopes([
        { agent: "a", files: ["src"] },
        { agent: "b", files: ["src/deep/file.mjs"] },
      ]),
    /overlapping file scopes/,
  );
});

test("validateDisjointScopes does not confuse sibling prefixes (src vs src-extra)", () => {
  validateDisjointScopes([
    { agent: "a", files: ["src"] },
    { agent: "b", files: ["src-extra"] },
  ]);
});

test("validateDisjointScopes allows one agent to own multiple non-conflicting paths", () => {
  validateDisjointScopes([{ agent: "a", files: ["src", "src/deep.mjs"] }, { agent: "b", files: ["docs"] }]);
});

test("validateDisjointScopes rejects absolute and escaping paths", () => {
  assert.throws(
    () => validateDisjointScopes([{ agent: "a", files: ["/etc/passwd"] }]),
    /relative path/,
  );
  assert.throws(
    () => validateDisjointScopes([{ agent: "a", files: ["../outside"] }]),
    /relative path/,
  );
});

// --- createWorktrees --------------------------------------------------------

test("createWorktrees adds a worktree + fresh branch per agent", async () => {
  const exec = fakeGit([["worktree add", ""]]);
  const result = await createWorktrees([{ agent: "api" }, { agent: "ui" }], {
    exec,
    root: "/data/run1/worktrees",
    runId: "run1",
  });
  assert.deepEqual(result, [
    { agent: "api", dir: join("/data/run1/worktrees", "api"), branch: "maestro/run1/api" },
    { agent: "ui", dir: join("/data/run1/worktrees", "ui"), branch: "maestro/run1/ui" },
  ]);
  assert.deepEqual(exec.calls[0], [
    "worktree",
    "add",
    join("/data/run1/worktrees", "api"),
    "-b",
    "maestro/run1/api",
  ]);
});

test("createWorktrees reattaches to an existing branch on resume", async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (args.includes("-b")) throw new Error("fatal: a branch named 'maestro/run1/api' already exists");
    return { stdout: "", stderr: "" };
  };
  const result = await createWorktrees([{ agent: "api" }], {
    exec,
    root: "/data/run1/worktrees",
    runId: "run1",
  });
  assert.equal(result[0].branch, "maestro/run1/api");
  // Second call drops -b and attaches to the surviving branch.
  assert.deepEqual(calls[1], [
    "worktree",
    "add",
    join("/data/run1/worktrees", "api"),
    "maestro/run1/api",
  ]);
});

test("createWorktrees propagates unrelated git failures", async () => {
  const exec = async () => {
    throw new Error("fatal: disk full");
  };
  await assert.rejects(
    () => createWorktrees([{ agent: "api" }], { exec, root: "/r", runId: "x" }),
    /disk full/,
  );
});

// --- buildWritePrompt -------------------------------------------------------

test("buildWritePrompt pins the agent to its worktree, branch, and scope", () => {
  const prompt = buildWritePrompt("Migrate the API layer.", {
    dir: "/data/wt/api",
    branch: "maestro/r1/api",
    files: ["src/api", "tests/api.test.mjs"],
  });
  assert.match(prompt, /WRITE MODE/);
  assert.match(prompt, /\/data\/wt\/api/);
  assert.match(prompt, /maestro\/r1\/api/);
  assert.match(prompt, /src\/api, tests\/api\.test\.mjs/);
  assert.match(prompt, /git add \+ git commit/);
  assert.ok(prompt.endsWith("Migrate the API layer."));
});

// --- integrateBranches ------------------------------------------------------

test("integrateBranches merges sequentially and runs the check after each merge", async () => {
  const order = [];
  const exec = async (args) => {
    order.push(`git:${args[0] === "merge" ? args[2] : args[0]}`);
    return { stdout: "", stderr: "" };
  };
  let checks = 0;
  const result = await integrateBranches(
    [
      { agent: "a", branch: "maestro/r/a" },
      { agent: "b", branch: "maestro/r/b" },
    ],
    {
      exec,
      targetBranch: "main",
      runCheck: async () => {
        checks += 1;
        order.push(`check:${checks}`);
      },
    },
  );
  assert.deepEqual(result, { merged: ["maestro/r/a", "maestro/r/b"], failed: null, remaining: [] });
  assert.equal(checks, 2);
  // merge a → check → merge b → check (strictly sequential).
  assert.deepEqual(order, ["git:maestro/r/a", "check:1", "git:maestro/r/b", "check:2"]);
});

test("integrateBranches aborts the conflicted merge and reports the remainder", async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "merge" && args.includes("maestro/r/b")) {
      throw new Error("CONFLICT (content): Merge conflict in src/shared.mjs");
    }
    return { stdout: "", stderr: "" };
  };
  const result = await integrateBranches(
    [
      { agent: "a", branch: "maestro/r/a" },
      { agent: "b", branch: "maestro/r/b" },
      { agent: "c", branch: "maestro/r/c" },
    ],
    { exec, targetBranch: "main" },
  );
  assert.deepEqual(result.merged, ["maestro/r/a"]);
  assert.equal(result.failed.agent, "b");
  assert.match(result.failed.reason, /merge conflict/i);
  assert.deepEqual(result.remaining, ["maestro/r/c"]);
  // The half-applied merge was aborted, and c was never attempted.
  assert.ok(calls.includes("merge --abort"));
  assert.ok(!calls.some((c) => c.includes("maestro/r/c")));
});

test("integrateBranches stops when the check command fails, keeping the merge visible", async () => {
  const exec = async () => ({ stdout: "", stderr: "" });
  const result = await integrateBranches(
    [
      { agent: "a", branch: "maestro/r/a" },
      { agent: "b", branch: "maestro/r/b" },
    ],
    {
      exec,
      targetBranch: "main",
      runCheck: async () => {
        throw new Error("2 tests failed");
      },
    },
  );
  assert.deepEqual(result.merged, []);
  assert.equal(result.failed.agent, "a");
  assert.match(result.failed.reason, /check failed after merge: 2 tests failed/);
  assert.deepEqual(result.remaining, ["maestro/r/b"]);
});

// --- cleanupWorktrees -------------------------------------------------------

test("cleanupWorktrees removes clean worktrees and keeps dirty ones", async () => {
  const removed = [];
  const exec = async (args) => {
    if (args[0] === "-C" && args[1] === "/wt/dirty") return { stdout: " M x.mjs\n", stderr: "" };
    if (args[0] === "-C") return { stdout: "", stderr: "" };
    if (args[0] === "worktree" && args[1] === "remove") {
      removed.push(args[2]);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const result = await cleanupWorktrees(
    [
      { agent: "clean", dir: "/wt/clean" },
      { agent: "dirty", dir: "/wt/dirty" },
    ],
    { exec },
  );
  assert.deepEqual(result.removed, ["/wt/clean"]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].agent, "dirty");
  assert.match(result.kept[0].reason, /uncommitted/);
  assert.deepEqual(removed, ["/wt/clean"]);
});

test("cleanupWorktrees skips worktrees whose directory is already gone", async () => {
  const exec = async (args) => {
    if (args[0] === "-C") throw new Error("no such directory");
    return { stdout: "", stderr: "" };
  };
  const result = await cleanupWorktrees([{ agent: "gone", dir: "/wt/gone" }], { exec });
  assert.deepEqual(result, { removed: [], kept: [] });
});
