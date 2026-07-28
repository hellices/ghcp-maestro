// /maestro install — fetch a saved-workflow .mjs from GitHub into the user
// workflow dir, so sharing a workflow is one command instead of a manual
// download-and-copy.
//
// Only GitHub https sources are accepted (blob URL, raw URL, or
// owner/repo/path@ref shorthand), the module is validated without ever being
// executed (node --check parse + export scan on a quarantined temp copy), and
// the file lands in the *user* dir — a project-level workflow of the same
// name still shadows it, preserving the project > user > bundled priority.

import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  validateWorkflowName,
  defaultWorkflowDirs,
} from "./saved-workflows.mjs";

const execFileAsync = promisify(execFile);

/** Hard cap on a downloaded workflow file. Saved workflows are small scripts;
 * anything near this size is almost certainly a mistake (or bundled deps,
 * which the sandboxed api does not support anyway). */
export const MAX_WORKFLOW_BYTES = 256 * 1024;

const RAW_HOST = "raw.githubusercontent.com";

/**
 * Parse an install source into a raw download URL plus derived workflow name.
 *
 * Accepted forms:
 * - `https://github.com/<owner>/<repo>/blob/<ref>/<path>.mjs`
 * - `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.mjs`
 * - `<owner>/<repo>/<path>.mjs[@ref]` (shorthand; ref defaults to `main`)
 *
 * Refs containing `/` (e.g. `feature/x` branches) are not supported in the
 * blob-URL form — the first path segment after /blob/ is taken as the ref.
 * Use a tag/short branch, the raw URL, or the shorthand's `@ref` instead
 * (a mis-split simply 404s at download time; nothing is written).
 *
 * @param {string} source
 * @returns {{ url: string, name: string }}
 */
export function parseWorkflowSource(source) {
  const s = (source ?? "").trim();
  if (!s) throw new Error("install source is required (GitHub URL or owner/repo/path.mjs)");

  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https:\/\//i.test(s)) {
      throw new Error("only https:// sources are supported");
    }
    const u = new URL(s);
    if (u.hostname === "github.com") {
      // /<owner>/<repo>/blob/<ref>/<path...>
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
      if (!m) throw new Error("github.com URL must point at a file (…/blob/<ref>/<path>.mjs)");
      url = `https://${RAW_HOST}/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
    } else if (u.hostname === RAW_HOST) {
      url = u.href;
    } else {
      throw new Error(`only github.com / ${RAW_HOST} sources are supported`);
    }
  } else {
    // owner/repo/path...mjs[@ref]
    const at = s.lastIndexOf("@");
    const ref = at > s.lastIndexOf("/") ? s.slice(at + 1) : "";
    const path = ref ? s.slice(0, at) : s;
    const parts = path.split("/");
    if (parts.length < 3 || parts.some((p) => !p)) {
      throw new Error(
        "shorthand must be owner/repo/path/to/workflow.mjs[@ref] or a github.com URL",
      );
    }
    const [owner, repo, ...rest] = parts;
    url = `https://${RAW_HOST}/${owner}/${repo}/${ref || "main"}/${rest.join("/")}`;
  }

  if (!url.endsWith(".mjs")) throw new Error("workflow source must be a .mjs file");
  const name = basename(new URL(url).pathname, ".mjs");
  return { url, name };
}

/**
 * Validate downloaded code WITHOUT executing it. Dynamic import() would run
 * the module's top-level statements — unacceptable for just-downloaded
 * third-party code — so instead:
 * 1. `node --check` on a quarantined temp copy parses the file (ESM, via the
 *    .mjs extension) and surfaces syntax errors with zero evaluation.
 * 2. A source scan requires a default/`run` export, mirroring the shape
 *    loadSavedWorkflow enforces at /maestro run time.
 * The scan is intentionally permissive: a false accept just means /maestro
 * run reports the real shape error later; nothing is ever executed here.
 *
 * @param {string} code
 */
async function validateWorkflowCode(code) {
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-verify-"));
  const file = join(dir, "candidate.mjs");
  try {
    await writeFile(file, code, "utf8");
    try {
      await execFileAsync(process.execPath, ["--check", file]);
    } catch (err) {
      const stderr = String(err?.stderr ?? "");
      const detail =
        stderr.split("\n").find((l) => l.includes("SyntaxError")) ??
        stderr.trim().split("\n").pop() ??
        String(err?.message ?? err);
      throw new SyntaxError(detail.trim() || "failed to parse workflow module");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const hasRunExport =
    /\bexport\s+default\b/.test(code) ||
    /\bexport\s+(?:async\s+)?function\s+run\b/.test(code) ||
    /\bexport\s+(?:const|let|var)\s+run\b/.test(code) ||
    /\bexport\s*\{[^}]*\b(?:run|default)\b[^}]*\}/.test(code);
  if (!hasRunExport) {
    throw new Error("workflow must default-export (or export 'run') a function");
  }
}

/**
 * Handle `/maestro install <source> [--force]`.
 *
 * All outcomes are reported via session.log; the function never throws for
 * user-input problems (bad source, name conflicts, validation failures).
 *
 * @param {object} session Host session (log + optional ui.elicitation).
 * @param {string} arg Raw argument string after the subcommand.
 * @param {{
 *   destDir?: string,
 *   fetchImpl?: typeof fetch,
 *   env?: Record<string, string|undefined>,
 * }} [opts] Injection points for tests.
 */
export async function installWorkflowCommand(session, arg, opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const tokens = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const force = tokens.includes("--force");
  const source = tokens.filter((t) => t !== "--force").join(" ");

  let parsed;
  try {
    parsed = parseWorkflowSource(source);
  } catch (err) {
    await session.log(`ghcp-maestro: install: ${err?.message ?? err}`, { level: "warning" });
    return;
  }
  const { url, name } = parsed;

  const nameProblem = validateWorkflowName(name);
  if (nameProblem) {
    await session.log(`ghcp-maestro: install: cannot install '${name}': ${nameProblem}`, {
      level: "warning",
    });
    return;
  }

  // User dir is dirs[1] (project > user > bundled) — installs are per-user so
  // a project can still override them.
  const destDir = opts.destDir ?? defaultWorkflowDirs({ env })[1];
  const destFile = join(destDir, `${name}.mjs`);

  if (!force && (await access(destFile).then(() => true, () => false))) {
    await session.log(
      `ghcp-maestro: install: '${name}' already exists at ${destFile}. Re-run with --force to overwrite.`,
      { level: "warning" },
    );
    return;
  }

  // Confirm before downloading third-party code when the host supports it.
  // Fail closed: an elicitation error is treated as a declined install.
  if (session.capabilities?.ui?.elicitation && session.ui?.elicitation) {
    let accepted = false;
    try {
      const res = await session.ui.elicitation({
        message: `Install workflow '${name}' from ${url}? This downloads third-party code that will run with your Copilot session's permissions.`,
        requestedSchema: { type: "object", properties: {} },
      });
      accepted = res?.action === "accept";
    } catch (err) {
      await session.log(
        `ghcp-maestro: install cancelled (confirmation dialog failed: ${err?.message ?? err}).`,
        { level: "warning" },
      );
      return;
    }
    if (!accepted) {
      await session.log("ghcp-maestro: install cancelled (declined at confirmation).");
      return;
    }
  }

  let code;
  try {
    // redirect:"manual" — a raw URL must not be allowed to bounce to a
    // non-GitHub host, so any 3xx is refused outright.
    const res = await fetchImpl(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await session.log(
        `ghcp-maestro: install: refused redirect (HTTP ${res.status}) for ${url} — sources must resolve directly.`,
        { level: "warning" },
      );
      return;
    }
    if (!res.ok) {
      await session.log(`ghcp-maestro: install: download failed (HTTP ${res.status}) for ${url}`, {
        level: "warning",
      });
      return;
    }
    const contentLength = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_WORKFLOW_BYTES) {
      await session.log(
        `ghcp-maestro: install: file too large (${contentLength} bytes > ${MAX_WORKFLOW_BYTES} max).`,
        { level: "warning" },
      );
      return;
    }
    code = await res.text();
  } catch (err) {
    await session.log(`ghcp-maestro: install: download failed: ${err?.message ?? err}`, {
      level: "warning",
    });
    return;
  }

  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > MAX_WORKFLOW_BYTES) {
    await session.log(
      `ghcp-maestro: install: file too large (${bytes} bytes > ${MAX_WORKFLOW_BYTES} max).`,
      { level: "warning" },
    );
    return;
  }

  try {
    await validateWorkflowCode(code);
  } catch (err) {
    const kind = err instanceof SyntaxError ? "syntax error" : "invalid workflow";
    await session.log(`ghcp-maestro: install: ${kind}: ${err?.message ?? err}`, {
      level: "warning",
    });
    return;
  }

  await mkdir(destDir, { recursive: true });
  await writeFile(destFile, code, "utf8");

  await session.log(`ghcp-maestro: installed '${name}' → ${destFile}`);
  await session.log(
    `ghcp-maestro: run it with: /maestro run ${name}. Note: installed workflows are third-party code — review ${destFile} before running.`,
  );
}
