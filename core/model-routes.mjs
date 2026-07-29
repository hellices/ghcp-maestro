// Per-phase / per-label model routing (#17) — zero-deps, pure.
//
// Fan-out workers doing mechanical subtasks rarely need the same model as the
// planner or the synth phase; running everything on the strongest model
// multiplies cost for no quality gain (the "cheap workers, premium lead"
// pattern used by leading multi-agent coding systems).
//
// Routing is OPT-IN, same principle as the token budget: nothing changes
// unless a routes map is explicitly configured. Labels are matched in
// insertion order, first match wins, `*` matches any suffix:
//
//   { "explore:*": "fast-model", "synth": "premium-model", "*": "default" }
//
// The task workflow resolves labels `plan`, `explore:<agent>`, and `synth`.
// An unmatched label leaves `spec.model` undefined so the adapter falls back
// to its own default model.

/**
 * Parse a routes map from a JSON string (or pass a plain object through).
 * Returns null for anything that is not a non-empty object of string→string —
 * a null routes map means "no routing".
 *
 * @param {unknown} raw
 * @returns {Record<string, string> | null}
 */
export function parseModelRoutes(raw) {
  let value = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      value = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const routes = {};
  for (const [k, v] of Object.entries(value)) {
    // Store trimmed keys/values so a padded config still matches at resolve time.
    if (typeof v === "string" && v.trim() && k.trim()) routes[k.trim()] = v.trim();
  }
  return Object.keys(routes).length > 0 ? routes : null;
}

/**
 * Default routes map from GHCP_MAESTRO_MODEL_ROUTES (JSON). Null = no routing.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string> | null}
 */
export function envModelRoutes(env = process.env) {
  return parseModelRoutes(env?.GHCP_MAESTRO_MODEL_ROUTES);
}

/**
 * Match a label against a route pattern. `*` matches any run of characters
 * (including ":"), everything else is literal.
 *
 * @param {string} label
 * @param {string} pattern
 * @returns {boolean}
 */
function matches(label, pattern) {
  if (pattern === "*") return true;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(label);
}

/**
 * Resolve the model for a label through the routes map. First match wins in
 * insertion order; returns undefined when routes is null/empty or nothing
 * matches (the adapter's default model then applies).
 *
 * @param {string} label - e.g. "plan", "explore:my-agent", "synth"
 * @param {Record<string, string> | null | undefined} routes
 * @returns {string | undefined}
 */
export function resolveModel(label, routes) {
  if (!routes) return undefined;
  for (const [pattern, model] of Object.entries(routes)) {
    if (matches(label, pattern)) return model;
  }
  return undefined;
}
