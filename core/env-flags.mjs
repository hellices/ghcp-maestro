/** Loose truthy check for opt-in/opt-out env flags (1/true/yes/on, case-insensitive). */
export function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/** Monitoring is on unless GHCP_MAESTRO_NO_MONITOR is truthy. */
export function monitorEnabled(env = {}) {
  return !isTruthyEnv(env.GHCP_MAESTRO_NO_MONITOR);
}
