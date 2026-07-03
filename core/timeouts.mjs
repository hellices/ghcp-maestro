// Subagent timeouts (ms). Two tiers, because the workloads are fundamentally
// different:
//
//   TIMEOUT_AGENT_MS  — real LLM research agents (task plan/explore/synth,
//                       brainstorm lenses). These fan out, fetch pages, read the
//                       repo, and reason over several turns, so their wall-clock
//                       routinely runs many minutes. A single LLM API call alone
//                       already floors at ~600s in the OpenAI/Anthropic SDKs, and
//                       Claude Code caps a Bash tool call at 600s, so we default
//                       to 10 minutes. Override with GHCP_MAESTRO_TIMEOUT_MS.
//
//   TIMEOUT_PROBE_MS  — diagnostics (pong, hello, env probes) that send fixed
//                       trivial prompts. These must fail FAST — a slow one means
//                       something is broken, not busy — so they stay short.
//                       Override with GHCP_MAESTRO_TIMEOUT_PROBE_MS.
//
// Shared by extension.mjs and runtime/probes.mjs.

/**
 * Resolve a positive-integer millisecond override from the environment, falling
 * back to `fallback` when the var is unset, blank, non-numeric, or non-positive.
 * Pure: the env object is injected so it is unit-testable.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function envInt(name, fallback, env = process.env) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const TIMEOUT_AGENT_MS = envInt("GHCP_MAESTRO_TIMEOUT_MS", 600_000);
export const TIMEOUT_PROBE_MS = envInt("GHCP_MAESTRO_TIMEOUT_PROBE_MS", 60_000);
