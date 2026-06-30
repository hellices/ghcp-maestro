// Copilot runtime factory — builds the bridge's planTask + runAgent from the
// shared core (spawn + plan helpers) over an isolated standalone-client adapter.
//
// vscode-free: every collaborator (createAdapter, spawn, plan helpers) is
// injected so this unit-tests under `node --test`. The composition root wires
// the real `createStandaloneClientAdapter`, `spawn`, `buildPlanPrompt`, and
// `parseAndValidatePlan`, having first resolved the Copilot CLI binary path
// (which is NOT process.execPath inside the VS Code extension host).

const PLAN_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 120_000;

/**
 * @param {{
 *   createAdapter: () => (import("../../extensions/ghcp-maestro/runtime/spawn.mjs").SubagentAdapter & { stop?: () => Promise<void> }),
 *   spawn: typeof import("../../extensions/ghcp-maestro/runtime/spawn.mjs").spawn,
 *   buildPlanPrompt: (task: string) => string,
 *   parseAndValidatePlan: (text: string) => Array<object>,
 *   defaultModel?: string,
 * }} deps
 */
export function createCopilotRuntime({ createAdapter, spawn, buildPlanPrompt, parseAndValidatePlan, defaultModel }) {
  let adapter = null;
  const getAdapter = () => (adapter ??= createAdapter());

  return {
    planTask: async ({ args }) => {
      const task = (args ?? "").trim();
      const planSpec = { id: "plan", agent: "plan", prompt: buildPlanPrompt(task), model: defaultModel, timeoutMs: PLAN_TIMEOUT_MS };
      const res = await spawn(planSpec, { adapter: getAdapter() });
      const text = (res?.output?.text ?? "").trim();
      const specs = parseAndValidatePlan(text).map((s) => ({
        ...s,
        model: s.model ?? defaultModel,
        timeoutMs: s.timeoutMs ?? AGENT_TIMEOUT_MS,
      }));
      return { task, agents: specs };
    },

    runAgent: (spec, ctx) =>
      spawn(spec, { adapter: getAdapter(), onProgress: ctx?.onProgress, signal: ctx?.signal }),

    synthesize: async ({ task, results, signal }) => {
      const collected = results
        .map((r, i) => `## Subtask ${i + 1} (${r?.spec?.agent ?? r?.id ?? i + 1})\n${r?.output?.text ?? r?.error ?? "(no output)"}`)
        .join("\n\n");
      const spec = {
        id: "synth",
        agent: "synth",
        prompt: `Task: ${task}\n\nThe subtask outputs below were produced by parallel agents. Synthesize them into a single coherent answer.\n\n${collected}`,
        model: defaultModel,
        timeoutMs: AGENT_TIMEOUT_MS,
      };
      const res = await spawn(spec, { adapter: getAdapter(), signal });
      return res?.output?.text ?? "";
    },

    stop: async () => {
      try {
        await adapter?.stop?.();
      } finally {
        adapter = null;
      }
    },
  };
}
