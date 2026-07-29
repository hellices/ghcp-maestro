// Per-run token budget (#14) — zero-deps, pure.
//
// A budget tracker accumulates the per-turn `assistant.usage` token counts the
// adapters surface through onProgress and answers one question: has this run
// crossed its cap? Accounting is always-on — the tracker aggregates usage even
// with no cap set (limit=null), so runs can report their token cost. Enforcement
// is opt-in (only when a budget is explicitly configured) and is a *soft stop*:
// agents already in flight finish, agents not yet scheduled are skipped (see
// spawn's budget check), and the workflow marks the run `stopped` so it stays
// resumable.

import { envInt } from "./timeouts.mjs";

/**
 * Parse a human-friendly token budget: plain integers plus `k` / `m` suffixes
 * ("500k" → 500 000, "1.5M" → 1 500 000). Returns null for anything invalid or
 * non-positive — a null budget means "no cap".
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseBudgetTokens(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!m) return null;
  const mult = { "": 1, k: 1_000, m: 1_000_000 }[m[2].toLowerCase()];
  const n = Math.round(Number(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Default per-run token budget from GHCP_MAESTRO_BUDGET_TOKENS (null = no cap).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number | null}
 */
export function envBudgetTokens(env = process.env) {
  return parseBudgetTokens(env?.GHCP_MAESTRO_BUDGET_TOKENS);
}

/**
 * Create a budget tracker. `add` is called from spawn's onProgress wrapper with
 * the per-turn token counts; `exceeded` is checked before scheduling each agent.
 *
 * @param {number | null | undefined} limitTokens
 * @returns {{ limit: number | null, add: (n: unknown) => void, used: () => number, exceeded: () => boolean }}
 */
export function createBudgetTracker(limitTokens) {
  const limit = Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : null;
  let used = 0;
  return {
    limit,
    add(n) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) used += n;
    },
    used: () => used,
    // Hitting the cap exactly counts as exceeded — the next agent must not
    // start once the budget is fully consumed.
    exceeded: () => limit !== null && used >= limit,
  };
}

/**
 * Coarse run-size label shown at the plan-approval gate: how many child
 * sessions is this run about to schedule?
 *
 * @param {number} totalAgents
 * @returns {"low" | "medium" | "high"}
 */
export function estimateRunSize(totalAgents) {
  if (totalAgents <= 4) return "low";
  if (totalAgents <= 8) return "medium";
  return "high";
}

/**
 * Subtask-count threshold for the advisory "large fan-out" warning at the plan
 * gate. GHCP_MAESTRO_LARGE_RUN_AGENTS, default 5.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function envLargeRunAgents(env = process.env) {
  return envInt("GHCP_MAESTRO_LARGE_RUN_AGENTS", 5, env);
}
