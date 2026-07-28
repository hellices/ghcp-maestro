// Subagent spawn API + pluggable adapter.
//
// The workflow runtime never calls the Copilot SDK directly. Instead it
// goes through an "adapter" that implements the SubagentAdapter interface.
//
// A `dummy` adapter (instant, deterministic, in-process) lets the concurrency,
// error, and timeout semantics be validated without burning model tokens. The
// production adapter is `standalone-client` (one isolated child Copilot session
// per spec); `llm-mediated` is retained as a host-session probe only.

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
 * @property {number} [attempts] total adapter attempts made (>= 1); cached
 *   replays carry the value persisted by the original run
 *
 * @typedef {Object} SubagentAdapter
 * @property {string} name
 * @property {(spec: AgentSpec, ctx: { signal?: AbortSignal, onProgress?: (partial: object) => void }) => Promise<unknown>} invoke
 */

/** Global cap defined by REQUIREMENTS §4.4. Enforced per spawnAll call. */
export const GLOBAL_AGENT_CAP = 1000;

/** Default per-run concurrency. */
export const DEFAULT_CONCURRENCY = 16;

/**
 * Parse GHCP_MAESTRO_RETRIES into a non-negative retry count (default 1).
 * Unlike timeouts' `envInt`, 0 is a valid value here ("never retry"), so this
 * has its own parser. Pure — the env object is injected for tests.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function envRetries(env = process.env) {
  const raw = env?.GHCP_MAESTRO_RETRIES;
  if (raw == null || String(raw).trim() === "") return 1;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/** Default extra attempts after a first `error` outcome. */
export const DEFAULT_RETRIES = envRetries();

/**
 * Exponential backoff with jitter: `base * 2^(attempt-1) * (0.5 + 0.5*rand)`.
 * `attempt` is the 1-based attempt that just failed. `rand` is injectable so
 * the bounds are unit-testable.
 *
 * @param {number} baseMs
 * @param {number} attempt
 * @param {() => number} [rand]
 * @returns {number}
 */
export function retryBackoffMs(baseMs, attempt, rand = Math.random) {
  return baseMs * 2 ** (attempt - 1) * (0.5 + 0.5 * rand());
}

/** Default backoff base (first retry waits ~0.5–1s). */
const DEFAULT_RETRY_BASE_MS = 1_000;

/**
 * Spawn one subagent through an adapter. Convenience wrapper around the
 * adapter's invoke that captures timing and normalizes the result envelope.
 *
 * If `opts.runHandle` is supplied and `spec.id` resolves to a previously
 * persisted agent record, that cached record is returned immediately and the
 * adapter is NOT invoked — this is what makes a run resumable.
 *
 * Transient failures retry: an `error`-status attempt is retried up to
 * `opts.retries` times (default GHCP_MAESTRO_RETRIES, default 1) with
 * exponential backoff + jitter. `timeout` and `aborted` outcomes never retry —
 * those are deliberate; retrying them would break the cancellation/timeout
 * semantics. Backoff sleeps abort with the run signal, in which case the
 * result is returned with status `aborted` (original error text preserved).
 *
 * @param {AgentSpec} spec
 * @param {{ adapter: SubagentAdapter, signal?: AbortSignal, runHandle?: { readAgent: Function, writeAgent: Function }, onProgress?: (evt: object) => void, retries?: number, retryBaseMs?: number }} opts
 * @returns {Promise<AgentResult>}
 */
export async function spawn(spec, opts) {
  if (!opts?.adapter) throw new TypeError("spawn: opts.adapter is required");
  const adapter = opts.adapter;
  const id = spec.id ?? newAgentId();
  const runHandle = opts.runHandle;

  if (runHandle && spec.id) {
    const cached = await runHandle.readAgent(spec.id);
    // Only successful results are replayed from cache. Failed/timed-out/aborted
    // records must re-run on resume — that is the documented /maestro-resume
    // contract ("already finished agents are served from cache, only the
    // missing or failed ones rerun").
    if (cached && cached.status === "ok") {
      return { ...cached, cached: true };
    }
  }

  const retries =
    Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : DEFAULT_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const firstStartedAt = Date.now();

  let result;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    result = await attemptSpawn(spec, id, adapter, opts);
    if (result.status !== "error" || attempt > retries) break;
    try {
      // sleep rejects immediately when the signal is already aborted, so an
      // abort landing anywhere between the failed attempt and the backoff is
      // funneled into the catch below.
      await sleep(retryBackoffMs(retryBaseMs, attempt), opts.signal);
    } catch {
      // Run was stopped while waiting to retry: surface that as aborted (the
      // deliberate outcome), keeping the original error text for diagnosis.
      result = { ...result, status: "aborted", finishedAt: Date.now() };
      break;
    }
  }
  result = { ...result, startedAt: firstStartedAt, attempts: attempt };

  if (runHandle && spec.id) {
    await runHandle.writeAgent({ agentId: spec.id, ...result });
  }

  return result;
}

/**
 * One adapter invocation normalized into an AgentResult envelope (without
 * `attempts` — the retry loop in `spawn` owns that).
 *
 * @param {AgentSpec} spec
 * @param {string} id
 * @param {SubagentAdapter} adapter
 * @param {{ signal?: AbortSignal, onProgress?: (evt: object) => void }} opts
 * @returns {Promise<AgentResult>}
 */
async function attemptSpawn(spec, id, adapter, opts) {
  const startedAt = Date.now();

  /** @type {{ signal: AbortSignal, dispose: () => void }} */
  const timeoutCtx = makeTimeoutSignal(spec.timeoutMs, opts.signal);

  let result;
  try {
    const onProgress = opts.onProgress
      ? (partial) => {
          try {
            opts.onProgress({
              ...partial,
              agent: spec.agent ?? null,
              specId: id,
              ts: Date.now(),
            });
          } catch {
            // monitoring is best-effort: never let it break the spawn
          }
        }
      : undefined;
    const output = await adapter.invoke(spec, { signal: timeoutCtx.signal, onProgress });
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
 *   onProgress?: (evt: object) => void,
 *   retries?: number,
 *   retryBaseMs?: number,
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
        onProgress: opts.onProgress,
        retries: opts.retries,
        retryBaseMs: opts.retryBaseMs,
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
