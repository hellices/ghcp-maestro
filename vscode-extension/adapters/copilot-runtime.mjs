// Copilot runtime factory — builds the bridge's planTask + runAgent from the
// shared core (spawn + plan helpers) over an isolated standalone-client adapter.
//
// vscode-free: every collaborator (createAdapter, spawn, plan helpers) is
// injected so this unit-tests under `node --test`. The composition root wires
// the real `createStandaloneClientAdapter`, `spawn`, `buildPlanPrompt`, and
// `parseAndValidatePlan`, having first resolved the Copilot CLI binary path
// (which is NOT process.execPath inside the VS Code extension host).

import { parseTaskOptions } from "../../core/task-options.mjs";

const DEFAULT_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

/**
 * @param {{
 *   createAdapter: () => (import("../../core/spawn.mjs").SubagentAdapter & { stop?: () => Promise<void> }),
 *   spawn: typeof import("../../core/spawn.mjs").spawn,
 *   buildPlanPrompt: (task: string) => string,
 *   parseAndValidatePlan: (text: string) => Array<object>,
 *   buildSynthPrompt: (input: { task: string, results: Array<object> }) => string,
 *   defaultModel?: string,
 *   planTimeoutMs?: number,
 *   agentTimeoutMs?: number,
 * }} deps
 */
export function createCopilotRuntime({ createAdapter, spawn, buildPlanPrompt, parseAndValidatePlan, buildSynthPrompt, defaultModel, planTimeoutMs, agentTimeoutMs }) {
  const planTimeout = Number.isFinite(planTimeoutMs) && planTimeoutMs > 0 ? planTimeoutMs : DEFAULT_PLAN_TIMEOUT_MS;
  const agentTimeout = Number.isFinite(agentTimeoutMs) && agentTimeoutMs > 0 ? agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  let adapter = null;
  const getAdapter = () => (adapter ??= createAdapter());

  return {
    planTask: async ({ args }) => {
      const raw = (args ?? "").trim();
      // Parse task-level options (--agents, --concurrency, --write, etc.)
      // using the same core parser as the CLI surface.
      const taskOpts = parseTaskOptions(raw);
      const task = taskOpts.task;
      const sizing = taskOpts.agents !== undefined ? { agentCount: taskOpts.agents } : {};
      const planSpec = {
        id: "plan",
        agent: "plan",
        prompt: buildPlanPrompt(task, undefined, undefined, undefined, taskOpts.write, sizing),
        model: defaultModel,
        timeoutMs: planTimeout,
      };
      const res = await spawn(planSpec, { adapter: getAdapter() });
      if (res?.status !== "ok") {
        throw new Error(
          `plan spawn ${res?.status ?? "unknown"}: ${res?.error ?? "no error message"}`,
        );
      }
      const text = (res?.output?.text ?? "").trim();
      if (!text) {
        const outPreview = (() => {
          try { return JSON.stringify(res.output)?.slice(0, 300); } catch { return "<unserializable>"; }
        })();
        throw new Error(`plan spawn returned no text; output=${outPreview}`);
      }
      const specs = parseAndValidatePlan(text, { agentCount: taskOpts.agents }).map((s) => ({
        ...s,
        model: s.model ?? defaultModel,
        timeoutMs: s.timeoutMs ?? agentTimeout,
      }));
      return {
        task,
        agents: specs,
        // Propagate per-run concurrency override so the bridge uses it
        // instead of the configured default. Do not apply task concurrency
        // to synth — synth is always a single agent.
        ...(taskOpts.concurrency !== undefined ? { concurrency: taskOpts.concurrency } : {}),
      };
    },

    runAgent: (spec, ctx) =>
      spawn(spec, { adapter: getAdapter(), onProgress: ctx?.onProgress, signal: ctx?.signal }),

    synthesize: async ({ task, results, signal }) => {
      const spec = {
        id: "synth",
        agent: "synth",
        prompt: buildSynthPrompt({ task, results }),
        model: defaultModel,
        timeoutMs: agentTimeout,
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
