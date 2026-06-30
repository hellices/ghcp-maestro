// LLM-mediated subagent adapter.
//
// Sends the spec as a new user-turn into the current Copilot session via
// `session.sendAndWait()`. The reply text becomes the agent output.
//
// Trade-offs (verified during M2.5 prototype):
//   - Effective concurrency = 1: the underlying CLI session is turn-based, so
//     even though spawnAll dispatches N invocations in parallel, they are
//     serialized by the host. Use this adapter for prompt isolation only,
//     not for real fan-out parallelism.
//   - `displayPrompt` is used to keep the timeline readable; the real prompt
//     carries instructions plus a sentinel header so future versions can
//     parse structured replies.
//   - This adapter does NOT spawn isolated child agent contexts. The reply
//     comes from the same model/session as the user's chat. For true
//     isolation use the `standalone-client` adapter.
//
// @experimental Real-world LLM behavior may produce non-deterministic
// formatting; consumers should treat `output.text` as opaque.

import { extractText } from "./reply-text.mjs";

/**
 * @typedef {import("../spawn.mjs").SubagentAdapter} SubagentAdapter
 * @typedef {import("../spawn.mjs").AgentSpec} AgentSpec
 */

/**
 * @param {{ session: { sendAndWait: Function }, modelOverride?: string }} deps
 * @returns {SubagentAdapter}
 */
export function createLlmMediatedAdapter(deps) {
  if (!deps?.session?.sendAndWait) {
    throw new TypeError(
      "createLlmMediatedAdapter: deps.session.sendAndWait is required",
    );
  }
  const { session } = deps;

  return {
    name: "llm-mediated",
    async invoke(spec, ctx) {
      if (ctx?.signal?.aborted) {
        throw ctx.signal.reason ?? new Error("aborted");
      }
      const sentinel = spec.id ?? `spec-${Math.random().toString(36).slice(2, 8)}`;
      const wrappedPrompt = buildSubagentPrompt(spec, sentinel);
      const displayPrompt = `[ghcp-maestro] ${spec.agent ?? "agent"}: ${spec.prompt.slice(0, 80)}`;

      const reply = await session.sendAndWait(
        {
          prompt: wrappedPrompt,
          displayPrompt,
          mode: "enqueue",
        },
        spec.timeoutMs ?? 60_000,
      );

      const text = extractText(reply);
      return { sentinel, agent: spec.agent ?? null, text };
    },
  };
}

function buildSubagentPrompt(spec, sentinel) {
  const lines = [
    `<<ghcp-maestro subagent>>`,
    `sentinel: ${sentinel}`,
    spec.agent ? `agent: ${spec.agent}` : null,
    spec.model ? `model: ${spec.model}` : null,
    ``,
    `Task:`,
    spec.prompt,
    ``,
    `Reply with the task result only. Do not include preamble, the sentinel, or explanations of what you are doing.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

