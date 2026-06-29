// Subagent spawn API + pluggable adapter.
//
// The workflow runtime never calls the Copilot SDK directly. Instead it
// goes through an "adapter" that implements the SubagentAdapter interface.
//
// M2 ships the `dummy` adapter (instant, deterministic, in-process) so the
// concurrency, error, and timeout semantics can be validated without
// burning model tokens. Real adapters (LLM-mediated via session.sendAndWait,
// or fork-based via session.rpc.agentRegistry.spawn) arrive in later
// milestones.

import { runWithConcurrency } from "./concurrency.mjs";

/**
 * @typedef {Object} AgentSpec
 * @property {string} prompt
 * @property {string} [agent]
 * @property {string} [model]
 * @property {string[]} [allowedTools]
 * @property {number} [timeoutMs]
 * @property {string} [id]
 *
 * @typedef {Object} AgentResult
 * @property {string} id
 * @property {AgentSpec} spec
 * @property {"ok"|"error"|"timeout"|"aborted"} status
 * @property {unknown} [output]
 * @property {string} [error]
 * @property {number} startedAt
 * @property {number} finishedAt
 *
 * @typedef {Object} SubagentAdapter
 * @property {string} name
 * @property {(spec: AgentSpec, ctx: { signal?: AbortSignal }) => Promise<unknown>} invoke
 */

/** Global cap defined by REQUIREMENTS §4.4. Enforced per spawnAll call. */
export const GLOBAL_AGENT_CAP = 1000;

/** Default per-run concurrency. */
export const DEFAULT_CONCURRENCY = 16;

/**
 * Spawn one subagent through an adapter. Convenience wrapper around the
 * adapter's invoke that captures timing and normalizes the result envelope.
 *
 * If `opts.runHandle` is supplied and `spec.id` resolves to a previously
 * persisted agent record, that cached record is returned immediately and the
 * adapter is NOT invoked — this is what makes a run resumable.
 *
 * @param {AgentSpec} spec
 * @param {{ adapter: SubagentAdapter, signal?: AbortSignal, runHandle?: { readAgent: Function, writeAgent: Function } }} opts
 * @returns {Promise<AgentResult>}
 */
export async function spawn(spec, opts) {
  if (!opts?.adapter) throw new TypeError("spawn: opts.adapter is required");
  const adapter = opts.adapter;
  const id = spec.id ?? newAgentId();
  const runHandle = opts.runHandle;

  if (runHandle && spec.id) {
    const cached = await runHandle.readAgent(spec.id);
    if (cached && (cached.status === "ok" || cached.status === "error" || cached.status === "timeout")) {
      return { ...cached, cached: true };
    }
  }

  const startedAt = Date.now();

  /** @type {{ signal: AbortSignal, dispose: () => void }} */
  const timeoutCtx = makeTimeoutSignal(spec.timeoutMs, opts.signal);

  let result;
  try {
    const output = await adapter.invoke(spec, { signal: timeoutCtx.signal });
    result = {
      id,
      spec,
      status: "ok",
      output,
      startedAt,
      finishedAt: Date.now(),
    };
  } catch (err) {
    /** @type {AgentResult["status"]} */
    let status = "error";
    if (timeoutCtx.signal.aborted && timeoutCtx.signal.reason?.name === "TimeoutError") {
      status = "timeout";
    } else if (opts.signal?.aborted) {
      status = "aborted";
    }
    result = {
      id,
      spec,
      status,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      finishedAt: Date.now(),
    };
  } finally {
    timeoutCtx.dispose();
  }

  if (runHandle && spec.id) {
    await runHandle.writeAgent({ agentId: spec.id, ...result });
  }

  return result;
}

/**
 * Spawn many subagents with a concurrency cap. Always resolves with an
 * AgentResult[] in input order — individual failures are reflected in
 * `result.status`, not thrown.
 *
 * @param {AgentSpec[]} specs
 * @param {{
 *   adapter: SubagentAdapter,
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   runHandle?: { readAgent: Function, writeAgent: Function },
 * }} opts
 * @returns {Promise<AgentResult[]>}
 */
export async function spawnAll(specs, opts) {
  if (!Array.isArray(specs)) throw new TypeError("spawnAll: specs must be an array");
  if (specs.length > GLOBAL_AGENT_CAP) {
    throw new RangeError(
      `spawnAll: ${specs.length} agents exceeds global cap of ${GLOBAL_AGENT_CAP}`,
    );
  }
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const tasks = specs.map(
    (spec) => () =>
      spawn(spec, {
        adapter: opts.adapter,
        signal: opts.signal,
        runHandle: opts.runHandle,
      }),
  );
  return runWithConcurrency(tasks, { concurrency, signal: opts?.signal });
}

/**
 * Built-in dummy adapter used by the M2 PoC and the test suite.
 * Honors `spec.input.delayMs` (default 0) and `spec.input.fail` (boolean).
 */
export const dummyAdapter = {
  name: "dummy",
  async invoke(spec, ctx) {
    const delayMs = Number(spec?.input?.delayMs ?? 0);
    if (delayMs > 0) {
      await sleep(delayMs, ctx.signal);
    }
    if (spec?.input?.fail) {
      throw new Error(`dummy adapter: forced failure for ${spec.prompt}`);
    }
    return { echo: spec.prompt, agent: spec.agent ?? null };
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function newAgentId() {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTimeoutSignal(timeoutMs, parent) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: parent ?? new AbortController().signal, dispose() {} };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => {
    const err = new Error(`agent timed out after ${timeoutMs}ms`);
    err.name = "TimeoutError";
    ac.abort(err);
  }, timeoutMs);
  const parentHandler = () => ac.abort(parent.reason);
  parent?.addEventListener?.("abort", parentHandler, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", parentHandler);
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
