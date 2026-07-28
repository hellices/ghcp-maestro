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
 * Build the synthesis prompt fed to the final synth agent: a fixed instruction
 * header, the original task, and a per-agent digest of the fan-out outputs.
 *
 * @param {{
 *   task: string,
 *   results: import("./workflow-log.mjs").AgentResultLike[],
 * }} params
 * @returns {string}
 */
export function buildSynthPrompt({ task, results }) {
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
  ].join("\n");
}
