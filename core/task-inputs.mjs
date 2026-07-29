// @file task inputs (#39) — parse `@<path>` references out of a task line and
// inline the referenced files into the plan / explore prompts.
//
// The industry pattern this implements: a one-line prompt *triggers* the
// orchestration while a markdown playbook/spec file *drives* each agent's
// correctness (Devin playbooks, Claude Code `@file`, spec-kit specs). The host
// reads the file once and injects it into every prompt, so isolated child
// sessions never have to rediscover it — and a missing file fails fast before
// any fan-out spends tokens.
//
// Parsing is pure; file access goes through an injectable `readFile` so tests
// never touch the real filesystem.

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { isAbsolute, resolve, normalize } from "node:path";

/** Caps that protect the context window from oversized specs. */
export const MAX_FILE_REFS = 4;
export const MAX_REF_CHARS = 16_000; // per file
export const MAX_TOTAL_REF_CHARS = 48_000; // across all files
export const MAX_REF_BYTES = 1_000_000; // on-disk size guard before reading

/**
 * Split a raw task line into `@path` references and the remaining task text.
 *
 * A reference is a whitespace-delimited token starting with `@` followed by a
 * path-ish string (no spaces). `@` alone, emails (`a@b`), and mid-word `@` are
 * left in the text untouched. Duplicate paths are collapsed to one read.
 *
 * @param {string} raw
 * @returns {{ refs: string[], task: string }}
 */
export function parseFileRefs(raw) {
  const refs = [];
  const rest = [];
  for (const token of String(raw ?? "").split(/\s+/)) {
    if (token.length > 1 && token.startsWith("@") && !token.slice(1).includes("@")) {
      const path = token.slice(1);
      if (!refs.includes(path)) refs.push(path);
    } else if (token.length > 0) {
      rest.push(token);
    }
  }
  return { refs, task: rest.join(" ") };
}

/**
 * Read every referenced file, enforcing count and size caps.
 *
 * Paths resolve against `cwd`. Any unreadable file throws — deliberately, so
 * the caller can abort before the plan agent spends a single token. Files
 * longer than MAX_REF_CHARS are truncated with an explicit marker rather than
 * rejected: a partial spec still beats no spec, and the marker tells both the
 * user (via logs) and the agents that a tail is missing.
 *
 * @param {string[]} refs
 * @param {{ cwd?: string, readFile?: (path: string) => Promise<string>, stat?: (path: string) => Promise<{ size: number }> }} [opts]
 * @returns {Promise<{ path: string, content: string, truncated: boolean }[]>}
 */
export async function loadFileRefs(refs, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const read = opts.readFile ?? ((p) => fsReadFile(p, "utf8"));
  // Guard against pathologically large files BEFORE reading them into memory:
  // only 16k chars survive truncation, so a multi-GB read would be pure waste
  // (and could stall the host). When a custom readFile is injected (tests),
  // the stat guard is skipped unless a matching stat is injected too.
  const stat = opts.stat ?? (opts.readFile ? null : fsStat);
  if (refs.length > MAX_FILE_REFS) {
    throw new Error(
      `too many @file references: ${refs.length} (max ${MAX_FILE_REFS})`,
    );
  }
  const loaded = [];
  let total = 0;
  for (const ref of refs) {
    const abs = isAbsolute(ref) ? normalize(ref) : resolve(cwd, ref);
    if (stat) {
      let info;
      try {
        info = await stat(abs);
      } catch (err) {
        throw new Error(`cannot read @${ref}: ${err?.message ?? err}`);
      }
      if (info.size > MAX_REF_BYTES) {
        throw new Error(
          `@${ref} is too large: ${info.size} bytes (max ${MAX_REF_BYTES})`,
        );
      }
    }
    let content;
    try {
      content = await read(abs);
    } catch (err) {
      throw new Error(`cannot read @${ref}: ${err?.message ?? err}`);
    }
    let truncated = false;
    if (content.length > MAX_REF_CHARS) {
      content = `${content.slice(0, MAX_REF_CHARS)}\n… [truncated: file continues for ${content.length - MAX_REF_CHARS} more characters]`;
      truncated = true;
    }
    total += content.length;
    if (total > MAX_TOTAL_REF_CHARS) {
      throw new Error(
        `@file references exceed the combined size cap (${MAX_TOTAL_REF_CHARS} chars) — trim the specs or reference fewer files`,
      );
    }
    loaded.push({ path: ref, content, truncated });
  }
  return loaded;
}

/**
 * Render loaded references as a reference-material block appended to a prompt.
 * Returns "" for an empty list so callers can append unconditionally.
 *
 * The content is the user's own spec (trusted input, unlike agent output), so
 * it is fenced for readability, not wrapped in the untrusted sentinels.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {string}
 */
export function buildFileRefsBlock(files) {
  if (!files || files.length === 0) return "";
  const parts = [
    "",
    "Reference material provided by the user (treat as the authoritative spec for this run):",
  ];
  for (const f of files) {
    parts.push("", `--- file: ${f.path} ---`, f.content, `--- end of ${f.path} ---`);
  }
  return parts.join("\n");
}
