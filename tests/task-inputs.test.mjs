import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFileRefs,
  loadFileRefs,
  buildFileRefsBlock,
  MAX_FILE_REFS,
  MAX_REF_CHARS,
  MAX_TOTAL_REF_CHARS,
} from "../core/task-inputs.mjs";

// --- parseFileRefs ---------------------------------------------------------

test("parseFileRefs extracts @path tokens and keeps the rest as the task", () => {
  const { refs, task } = parseFileRefs("@docs/spec.md focus on the API layer");
  assert.deepEqual(refs, ["docs/spec.md"]);
  assert.equal(task, "focus on the API layer");
});

test("parseFileRefs handles multiple refs anywhere in the line", () => {
  const { refs, task } = parseFileRefs("compare @a.md against @b.md carefully");
  assert.deepEqual(refs, ["a.md", "b.md"]);
  assert.equal(task, "compare against carefully");
});

test("parseFileRefs collapses duplicate paths", () => {
  const { refs } = parseFileRefs("@x.md and @x.md again");
  assert.deepEqual(refs, ["x.md"]);
});

test("parseFileRefs leaves emails, bare @, and mid-word @ alone", () => {
  const { refs, task } = parseFileRefs("mail a@b.com about @ nothing");
  assert.deepEqual(refs, []);
  assert.equal(task, "mail a@b.com about @ nothing");
});

test("parseFileRefs on a plain line returns it untouched", () => {
  const { refs, task } = parseFileRefs("just a normal task");
  assert.deepEqual(refs, []);
  assert.equal(task, "just a normal task");
});

test("parseFileRefs tolerates empty / nullish input", () => {
  assert.deepEqual(parseFileRefs(""), { refs: [], task: "" });
  assert.deepEqual(parseFileRefs(undefined), { refs: [], task: "" });
});

// --- loadFileRefs ----------------------------------------------------------

function fakeRead(files) {
  return async (abs) => {
    for (const [suffix, content] of Object.entries(files)) {
      if (abs.endsWith(suffix)) return content;
    }
    const err = new Error(`ENOENT: no such file or directory, open '${abs}'`);
    throw err;
  };
}

test("loadFileRefs reads files relative to cwd", async () => {
  const files = await loadFileRefs(["spec.md"], {
    cwd: "/proj",
    readFile: async (abs) => {
      assert.equal(abs, "/proj/spec.md");
      return "hello spec";
    },
  });
  assert.deepEqual(files, [{ path: "spec.md", content: "hello spec", truncated: false }]);
});

test("loadFileRefs throws a clear error for unreadable files", async () => {
  await assert.rejects(
    loadFileRefs(["missing.md"], { cwd: "/proj", readFile: fakeRead({}) }),
    /cannot read @missing\.md: ENOENT/,
  );
});

test("loadFileRefs rejects more than MAX_FILE_REFS references", async () => {
  const refs = Array.from({ length: MAX_FILE_REFS + 1 }, (_, i) => `f${i}.md`);
  await assert.rejects(loadFileRefs(refs, { readFile: fakeRead({}) }), /too many @file references/);
});

test("loadFileRefs truncates oversized files with a marker", async () => {
  const big = "x".repeat(MAX_REF_CHARS + 500);
  const [file] = await loadFileRefs(["big.md"], {
    cwd: "/proj",
    readFile: fakeRead({ "big.md": big }),
  });
  assert.equal(file.truncated, true);
  assert.ok(file.content.includes("[truncated: file continues for 500 more characters]"));
  assert.ok(file.content.length < big.length);
});

test("loadFileRefs enforces the combined size cap", async () => {
  const chunk = "y".repeat(MAX_REF_CHARS);
  const refs = ["a.md", "b.md", "c.md", "d.md"];
  assert.ok(MAX_REF_CHARS * refs.length > MAX_TOTAL_REF_CHARS, "test premise");
  await assert.rejects(
    loadFileRefs(refs, {
      cwd: "/proj",
      readFile: fakeRead({ "a.md": chunk, "b.md": chunk, "c.md": chunk, "d.md": chunk }),
    }),
    /combined size cap/,
  );
});

test("loadFileRefs accepts absolute paths as-is", async () => {
  const [file] = await loadFileRefs(["/abs/spec.md"], {
    cwd: "/elsewhere",
    readFile: async (abs) => {
      assert.equal(abs, "/abs/spec.md");
      return "abs content";
    },
  });
  assert.equal(file.content, "abs content");
});

// --- buildFileRefsBlock ----------------------------------------------------

test("buildFileRefsBlock renders fenced sections per file", () => {
  const block = buildFileRefsBlock([
    { path: "a.md", content: "AAA" },
    { path: "b.md", content: "BBB" },
  ]);
  assert.ok(block.includes("Reference material provided by the user"));
  assert.ok(block.includes("--- file: a.md ---\nAAA\n--- end of a.md ---"));
  assert.ok(block.includes("--- file: b.md ---\nBBB\n--- end of b.md ---"));
});

test("buildFileRefsBlock returns empty string for no files", () => {
  assert.equal(buildFileRefsBlock([]), "");
  assert.equal(buildFileRefsBlock(undefined), "");
});
