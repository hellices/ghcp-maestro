// /maestro compose (#16) — generate a saved workflow script from a
// natural-language description.
//
// Saved workflows (M5) are powerful but writing one requires knowing the
// sandboxed `api` surface. compose closes that gap: a planner agent receives
// the workflow-api reference plus the user's description and writes the
// script; the result is statically validated (parse + forbidden-global scan,
// nothing executed), shown to the user for review, dry-run against a
// token-free echo adapter only AFTER approval, and finally saved to the
// project workflow dir so it immediately becomes `/maestro run <name>`.
//
// Non-interactive hosts fail closed: the generated script is written to a
// `.draft` file (invisible to workflow discovery) and never dry-run or saved
// without a human in the loop.

import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { spawn as spawnProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn } from "./spawn.mjs";
import { validateWorkflowName, defaultWorkflowDirs } from "./saved-workflows.mjs";
import { validateWorkflowCode } from "./workflow-install.mjs";

const DRY_RUN_CHILD = fileURLToPath(new URL("./compose-dry-run-child.mjs", import.meta.url));

/** Timeout for the single dry-run execution (echo adapter, no tokens). */
const DRY_RUN_TIMEOUT_MS = 30_000;

/**
 * Parse `/maestro compose <description> [--name <kebab>] [--force]`.
 * Flags may appear anywhere; everything else is the description.
 *
 * @param {string} raw
 * @returns {{ description: string, name?: string, force: boolean }}
 */
export function parseComposeArgs(raw) {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const rest = [];
  let name;
  let force = false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--force") {
      force = true;
    } else if (tokens[i] === "--name") {
      // A missing or flag-valued name is kept as "" so validateWorkflowName
      // reports it clearly instead of silently falling back to the slug.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        name = tokens[i + 1];
        i += 1;
      } else {
        name = "";
      }
    } else {
      rest.push(tokens[i]);
    }
  }
  return { description: rest.join(" "), ...(name !== undefined ? { name } : {}), force };
}

/**
 * Derive a valid workflow name from a free-text description: kebab-case,
 * <=40 chars, never a reserved name. Fallback when `--name` isn't given.
 *
 * @param {string} description
 * @returns {string}
 */
export function slugifyWorkflowName(description) {
  let slug = String(description ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = `wf-${slug}`.slice(0, 40).replace(/-+$/g, "");
  if (validateWorkflowName(slug)) slug = `${slug.slice(0, 37)}-wf`;
  return slug;
}

/**
 * The planner meta-prompt: the workflow-api contract plus the constraints a
 * generated script must satisfy to pass the static validation below. The
 * description is fenced as data so a crafty description can't restyle the
 * surrounding instructions.
 *
 * @param {{ description: string, name: string }} opts
 * @returns {string}
 */
export function buildComposePrompt({ description, name }) {
  return [
    "You write a saved workflow script for ghcp-maestro (a GitHub Copilot CLI multi-agent runtime).",
    "",
    "A saved workflow is ONE ESM module that default-exports an async function receiving a single `api` object. The script may use ONLY the injected `api` — no imports of any kind, no Node builtins, no `process`/`globalThis`/`global`/`fetch`/`eval`/`Function`, no `console` (stdout corrupts the host's JSON-RPC channel — log via `api.log` only), no filesystem or shell access. Violations are rejected by a static scan before the script is ever run.",
    "",
    "The `api` object:",
    "- `api.args` — object; invocation args (`/maestro run <name> {\"key\":...}` or `{ input: \"<text>\" }`)",
    "- `api.log(message)` — report progress to the user (await it)",
    "- `api.spawn({ id, agent, prompt, timeoutMs? })` — run ONE isolated child Copilot session; resolves `{ status, output: { text }, error }` (status: \"ok\" | \"error\" | \"timeout\" | \"aborted\")",
    "- `api.spawnAll(specs)` — run MANY specs in parallel (concurrency-capped); resolves an array of the same result shape, never throws for individual failures",
    "- `api.runPhase(name, specs)` — like spawnAll but tracked as a named phase in run progress; resolves `{ results, elapsedMs }`",
    "- `api.phase(name, fn)` — group + time an arbitrary step; logs start/done/failed",
    "- `api.multiAngle(task, { angles?, reviewers? })` — fan a task out across analytical angles and cross-review",
    "- `api.adversarialReview(findings)` — reviewer agents attack a draft's weaknesses",
    "- `api.fixLoop({ check, applyFix, maxIters?, until?, stallRounds? })` — iterate until a check converges",
    "- `api.crossCheck(claims)` — verify claims across independent sources",
    "",
    "Requirements for your output:",
    `1. Reply with ONE fenced code block containing the complete module — nothing outside the fence matters.`,
    `2. Start the module with: export const description = "<one line>";`,
    "3. Default-export an async function taking `api`. Always `await api.log(...)` progress at each step and end by logging a concise final summary.",
    "4. Check `result.status === \"ok\"` before using an agent's output; degrade gracefully (log and continue or stop) instead of throwing when an agent fails.",
    "5. Keep it small: 2-4 phases, <= 8 agents total, prompts as plain template literals.",
    "6. Do not invent api methods beyond the list above.",
    "",
    `The workflow will be saved as '${name}'. Build it from this description:`,
    "",
    "```",
    description,
    "```",
  ].join("\n");
}

/**
 * Pull the workflow module source out of the planner's reply: the largest
 * fenced code block, or the whole reply when it already looks like a module.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractWorkflowCode(text) {
  const raw = String(text ?? "");
  // Tolerate anything after the opening fence (language tag, trailing
  // spaces, "js " etc.) — planners are not consistent here.
  const blocks = [...raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  const best = blocks.sort((a, b) => b.length - a.length)[0];
  if (best) return best;
  const trimmed = raw.trim();
  if (/^(\/\/|\/\*|export\b)/.test(trimmed)) return trimmed;
  throw new Error("the planner reply contains no fenced code block");
}

/**
 * Strip string literals, comments, and regex literals so the forbidden-global
 * scan doesn't flag words like "process" inside agent prompts. Template-literal
 * interpolations (`${...}`) are KEPT — code hidden inside them must still be
 * scanned. Plain character walk; no regex backtracking.
 *
 * A `/` opens a regex literal only when the previous significant character
 * cannot end an expression (so `a / b` stays division). Every stripped
 * literal leaves a `0` placeholder in the output so a following `/` is still
 * read as division (`"a" / x` must not open a regex and swallow code).
 * Misclassifying a regex as division only ADDS text to the scan — fail-closed
 * for this use.
 *
 * @param {string} code
 * @returns {string}
 */
export function stripLiterals(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  // state: none | sq | dq | tpl | line | block | regex | regexClass;
  // tplDepth counts ${ } nesting
  let state = "none";
  const tplExprDepth = [];
  const regexCanFollow = (s) => {
    const t = s.replace(/\s+$/, "");
    const prev = t.slice(-1);
    if (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev)) return true;
    // keywords that end in an identifier char but cannot end an expression
    return /(?:^|[^\w$])(?:return|throw|typeof|case|in|of|delete|void|do|else|yield|await|instanceof|new)$/.test(t);
  };
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (state === "none") {
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      else if (c === "/" && next === "/") { state = "line"; i += 1; }
      else if (c === "/" && next === "*") { state = "block"; i += 1; }
      else if (c === "/" && regexCanFollow(out)) state = "regex";
      else {
        out += c;
        if (c === "}" && tplExprDepth.length > 0) {
          if (tplExprDepth[tplExprDepth.length - 1] === 0) {
            tplExprDepth.pop();
            out = out.slice(0, -1);
            state = "tpl";
          } else {
            tplExprDepth[tplExprDepth.length - 1] -= 1;
          }
        } else if (c === "{" && tplExprDepth.length > 0) {
          tplExprDepth[tplExprDepth.length - 1] += 1;
        }
      }
    } else if (state === "sq") {
      if (c === "\\") i += 1;
      else if (c === "'") { state = "none"; out += "0"; }
    } else if (state === "dq") {
      if (c === "\\") i += 1;
      else if (c === '"') { state = "none"; out += "0"; }
    } else if (state === "tpl") {
      if (c === "\\") i += 1;
      else if (c === "`") { state = "none"; out += "0"; }
      else if (c === "$" && next === "{") {
        tplExprDepth.push(0);
        state = "none";
        i += 1;
      }
    } else if (state === "regex") {
      if (c === "\\") i += 1;
      else if (c === "[") state = "regexClass";
      else if (c === "/" || c === "\n") { state = "none"; out += "0"; }
    } else if (state === "regexClass") {
      if (c === "\\") i += 1;
      else if (c === "]") state = "regex";
    } else if (state === "line") {
      if (c === "\n") { state = "none"; out += "\n"; }
    } else if (state === "block") {
      if (c === "*" && next === "/") { state = "none"; i += 1; }
    }
    i += 1;
  }
  return out;
}

const FORBIDDEN = [
  [/\bimport\b/, "import (static, dynamic, or import.meta) — use only the injected api"],
  [/\brequire\b/, "require — use only the injected api"],
  [/\bprocess\b/, "process — environment access is not available to workflows"],
  [/\bglobalThis\b/, "globalThis — global access is not available to workflows"],
  [/\bglobal\b/, "global — global access is not available to workflows"],
  [/\beval\b/, "eval — dynamic code execution is not allowed"],
  [/\bFunction\b/, "Function constructor — dynamic code execution is not allowed"],
  [/\bconstructor\b/, "constructor access — reaching Function via .constructor is not allowed"],
  [/\bfetch\b/, "fetch — network access is not available to workflows"],
  [/\bWebSocket\b/, "WebSocket — network access is not available to workflows"],
  [/\bchild_process\b/, "child_process — shell access is not available to workflows"],
  [/\bconsole\b/, "console — stdout corrupts the host JSON-RPC channel; use api.log"],
];

/**
 * Scan generated code (string literals and comments stripped) for globals a
 * saved workflow must not touch. Returns human-readable problems; empty means
 * the scan passed. A scan is not a sandbox — the review gate and the
 * user-owned trust boundary of saved workflows still apply — but it catches
 * every straightforward escape a planner is likely to emit.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function scanForbiddenGlobals(code) {
  const stripped = stripLiterals(code);
  const problems = [];
  for (const [re, reason] of FORBIDDEN) {
    if (re.test(stripped)) problems.push(reason);
  }
  return problems;
}

/**
 * Execute the candidate module once against a token-free echo adapter, so a
 * script that parses but blows up at runtime (bad api usage, unhandled
 * failure path) is caught before it is saved. Only called after the user has
 * reviewed and approved the code.
 *
 * The candidate runs in a disposable child `node` process
 * (compose-dry-run-child.mjs) so the timeout is HARD: a synchronous hang
 * (`while (true) {}`) or a timer leaked during module evaluation is killed
 * with the process instead of stalling the host session.
 *
 * @param {string} code
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function dryRunWorkflowCode(code, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DRY_RUN_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), "ghcp-maestro-compose-"));
  const file = join(dir, "candidate.mjs");
  try {
    await writeFile(file, code, "utf8");
    await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [DRY_RUN_CHILD, file], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`dry run exceeded ${timeoutMs}ms`));
        else if (exitCode === 0) resolve();
        else reject(new Error(stderr.trim() || `dry run exited with code ${exitCode}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write the generated code to a `.draft` file without clobbering existing
 * drafts: an occupied `<name>.mjs.draft` makes the draft land at the next
 * free `<name>-N.mjs.draft`, so manual edits to a previous draft always
 * survive a re-run of compose (`--force` only affects the runnable `.mjs`).
 *
 * @param {string} destDir
 * @param {string} name
 * @param {string} code
 * @returns {Promise<string>} the path actually written
 */
async function writeDraft(destDir, name, code) {
  await mkdir(destDir, { recursive: true });
  let draftFile = join(destDir, `${name}.mjs.draft`);
  for (let n = 2; await fileExists(draftFile); n++) {
    draftFile = join(destDir, `${name}-${n}.mjs.draft`);
  }
  await writeFile(draftFile, code, "utf8");
  return draftFile;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle `/maestro compose <description> [--name <kebab>] [--force]`.
 *
 * All outcomes are reported via session.log; user-input problems never throw.
 *
 * @param {object} session Host session (log + optional ui.elicitation).
 * @param {string} arg Raw argument string after the subcommand.
 * @param {{
 *   adapter?: import("./spawn.mjs").SubagentAdapter,
 *   getAdapter?: () => import("./spawn.mjs").SubagentAdapter,
 *   destDir?: string,
 *   env?: Record<string, string|undefined>,
 *   timeoutMs?: number,
 *   dryRun?: typeof dryRunWorkflowCode,
 * }} [opts] Injection points for the composition root and tests.
 */
export async function composeWorkflowCommand(session, arg, opts = {}) {
  const env = opts.env ?? process.env;
  const warn = (msg) => session.log(`ghcp-maestro: compose: ${msg}`, { level: "warning" });

  const { description, name: requestedName, force } = parseComposeArgs(arg);
  if (!description) {
    await warn("a workflow description is required. Example: /maestro compose review a PR from 3 angles --name tri-review");
    return;
  }

  const name = requestedName ?? slugifyWorkflowName(description);
  const nameProblem = validateWorkflowName(name);
  if (nameProblem) {
    await warn(`cannot use name '${name}': ${nameProblem}`);
    return;
  }

  // Project dir (dirs[0]) — a composed workflow belongs to the project that
  // described it; the user dir stays for installs.
  const destDir = opts.destDir ?? defaultWorkflowDirs({ env })[0];
  const destFile = join(destDir, `${name}.mjs`);
  if (!force && (await fileExists(destFile))) {
    await warn(`'${name}' already exists at ${destFile}. Re-run with --force to overwrite, or pick another --name.`);
    return;
  }

  const adapter = opts.adapter ?? opts.getAdapter?.();
  if (!adapter) {
    await warn("no adapter available to run the planner agent");
    return;
  }

  await session.log(`ghcp-maestro: compose: generating workflow '${name}' (1 planner agent)…`);
  const planner = await spawn(
    {
      id: `compose-${name}`,
      agent: "compose",
      prompt: buildComposePrompt({ description, name }),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    },
    { adapter },
  );
  if (planner.status !== "ok") {
    await warn(`planner agent ${planner.status}: ${planner.error ?? "(no error)"}`);
    return;
  }

  let code;
  try {
    code = extractWorkflowCode(planner.output?.text ?? "");
  } catch (err) {
    await warn(String(err?.message ?? err));
    return;
  }

  // Static validation — nothing is executed here.
  try {
    await validateWorkflowCode(code);
  } catch (err) {
    await warn(`generated code failed validation: ${err?.message ?? err}`);
    return;
  }
  const problems = scanForbiddenGlobals(code);
  if (problems.length > 0) {
    await warn(`generated code touches forbidden globals:\n  - ${problems.join("\n  - ")}`);
    return;
  }

  // Show the full script — the review gate below refers to it. A four-backtick
  // fence so triple backticks inside the code cannot truncate the preview.
  await session.log(`ghcp-maestro: compose: generated '${name}':\n\`\`\`\`js\n${code}\n\`\`\`\``);

  // Review gate. Non-interactive hosts fail closed: draft only, never saved
  // or executed without a human decision.
  const interactive = session.capabilities?.ui?.elicitation === true && session.ui?.elicitation;
  if (!interactive) {
    const draftFile = await writeDraft(destDir, name, code);
    await session.log(
      `ghcp-maestro: compose: non-interactive host — draft written to ${draftFile}. Review it, then rename to ${name}.mjs to enable /maestro run ${name}.`,
    );
    return;
  }

  let accepted = false;
  try {
    const res = await session.ui.elicitation({
      message: `Save workflow '${name}'? Review the generated script in the log above — it will run with your Copilot session's permissions whenever you invoke /maestro run ${name}.`,
      requestedSchema: { type: "object", properties: {} },
    });
    accepted = res?.action === "accept";
  } catch (err) {
    await warn(`cancelled (review dialog failed: ${err?.message ?? err})`);
    return;
  }
  if (!accepted) {
    await session.log("ghcp-maestro: compose: cancelled (declined at review).");
    return;
  }

  // Dry-run AFTER approval: one execution against a token-free echo adapter
  // catches runtime blow-ups (bad api usage) before the script becomes
  // runnable. A failure keeps the draft for manual editing.
  const dryRun = opts.dryRun ?? dryRunWorkflowCode;
  try {
    await dryRun(code);
  } catch (err) {
    const draftFile = await writeDraft(destDir, name, code);
    await warn(
      `dry run failed: ${err?.message ?? err} — draft kept at ${draftFile}. Fix it manually, then rename to ${name}.mjs.`,
    );
    return;
  }

  await mkdir(destDir, { recursive: true });
  await writeFile(destFile, code, "utf8");
  await session.log(`ghcp-maestro: compose: saved '${name}' → ${destFile}`);
  await session.log(`ghcp-maestro: run it with: /maestro run ${name}`);
}
