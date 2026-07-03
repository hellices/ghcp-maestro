// Shared synthesis prompt builder.
//
// Both surfaces run the same "fan out → synth" shape, but the CLI task workflow
// (core/builtin-workflows.mjs) and the VS Code runtime (copilot-runtime.mjs)
// used to each hand-roll the synth digest + prompt, so they drifted. This module
// owns the one canonical synth prompt so the two surfaces stay in lock-step. Pure
// (no IO), so it unit-tests off the SDK.

import { agentDigest } from "./workflow-log.mjs";

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
  return [
    "You are a synthesis agent. Several independent subagents tackled different parts of a single task.",
    "Merge their outputs into a coherent final answer to the original task.",
    "Be concrete, deduplicate, surface disagreements, and end with a short 'next actions' list of at most 5 items.",
    "",
    `Original task: ${task}`,
    "",
    "Subagent outputs:",
    digest,
  ].join("\n");
}
