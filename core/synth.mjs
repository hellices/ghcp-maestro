// Shared synthesis prompt builder.
//
// Both surfaces run the same "fan out → synth" shape, but the CLI task workflow
// (core/builtin-workflows.mjs) and the VS Code runtime (copilot-runtime.mjs)
// used to each hand-roll the synth digest + prompt, so they drifted. This module
// owns the one canonical synth prompt so the two surfaces stay in lock-step. Pure
// (no IO), so it unit-tests off the SDK.

import { agentDigest } from "./workflow-log.mjs";
import { UNTRUSTED_NOTICE, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "./plan.mjs";

/**
 * Build the verification prompt fed to the opt-in verify agent (#31): given
 * the original task and the fan-out digest, judge whether each subtask output
 * actually serves the original objective (MAST-style high-level objective
 * verification — surface checks like "it compiles" are not enough).
 *
 * @param {{
 *   task: string,
 *   results: import("./workflow-log.mjs").AgentResultLike[],
 * }} params
 * @returns {string}
 */
export function buildVerifyPrompt({ task, results }) {
  const digest = agentDigest(results ?? [], { emptyPlaceholder: "(no output)" });
  return [
    "You are a verification agent. Several independent subagents tackled different parts of a single task.",
    "For EACH subagent output below, judge it against the ORIGINAL TASK objective (not just surface plausibility):",
    "- verdict: met / partially-met / not-met",
    "- one-line justification",
    "- concrete gaps or unsupported claims, if any",
    "Finish with an overall line: 'OVERALL: <n>/<total> subtasks met the objective' plus the single most important gap.",
    "Do not rewrite or merge the outputs — verification only.",
    "",
    `Original task: ${task}`,
    "",
    "Subagent outputs:",
    UNTRUSTED_NOTICE,
    UNTRUSTED_OPEN,
    digest,
    UNTRUSTED_CLOSE,
  ].join("\n");
}

/**
 * Build the synthesis prompt fed to the final synth agent: a fixed instruction
 * header, the original task, and a per-agent digest of the fan-out outputs.
 * When a verification report is provided (opt-in verify phase, #31), it is
 * appended so synthesis can weigh unverified claims.
 *
 * @param {{
 *   task: string,
 *   results: import("./workflow-log.mjs").AgentResultLike[],
 *   verifyReport?: string,
 * }} params
 * @returns {string}
 */
export function buildSynthPrompt({ task, results, verifyReport }) {
  const digest = agentDigest(results ?? [], { emptyPlaceholder: "(no output)" });
  const anyFailed = (results ?? []).some((r) => r.status && r.status !== "ok");
  return [
    "You are a synthesis agent. Several independent subagents tackled different parts of a single task.",
    "Merge their outputs into a coherent final answer to the original task.",
    "Be concrete, deduplicate, surface disagreements, and end with a short 'next actions' list of at most 5 items.",
    // Disclosed only when needed so the all-ok prompt stays byte-identical.
    ...(anyFailed
      ? [
          "Some subagents FAILED (marked below). Do not invent their contribution: state explicitly which angles are missing and how that limits the answer.",
        ]
      : []),
    "",
    `Original task: ${task}`,
    "",
    "Subagent outputs:",
    // Cross-agent injection hardening (#33): subagent text is data, not
    // instructions — the synth model must not obey directives found inside it.
    UNTRUSTED_NOTICE,
    UNTRUSTED_OPEN,
    digest,
    UNTRUSTED_CLOSE,
    // Verify report (#31): appended only when the opt-in verify phase ran so
    // the default prompt stays byte-identical.
    ...(verifyReport
      ? [
          "",
          "A verification agent independently judged each subtask against the original objective. Weigh its verdicts when merging — do not present 'not-met' or 'partially-met' claims as settled facts:",
          UNTRUSTED_OPEN,
          verifyReport,
          UNTRUSTED_CLOSE,
        ]
      : []),
  ].join("\n");
}
