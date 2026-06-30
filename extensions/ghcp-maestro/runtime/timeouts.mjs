// Per-phase subagent timeouts (ms). Named so the intent is explicit and the
// values stay consistent across the built-in workflows and the diagnostic
// probes. Shared by extension.mjs and runtime/probes.mjs.

export const TIMEOUT_PROBE_MS = 30_000;
export const TIMEOUT_AGENT_MS = 60_000;
export const TIMEOUT_EXPLORE_MS = 90_000;
export const TIMEOUT_LONG_MS = 120_000;
