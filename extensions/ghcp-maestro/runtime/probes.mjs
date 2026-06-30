// Diagnostic probes (M2.5 / M2.6 measurement).
//
// These are not part of the production workflow surface — they exist to measure
// adapter round-trips in a given host environment and are triggered only via the
// GHCP_MAESTRO_PROBE_* env vars (and `/maestro pong` for the standalone path).
// Kept out of extension.mjs so the entry file stays focused on the production
// commands and workflows.
//
// Output goes through the injected `session.log()` only (JSON-RPC stdio rule).

import { spawn } from "./spawn.mjs";
import { newRunId } from "./run-store.mjs";
import { createLlmMediatedAdapter } from "./adapters/llm-mediated.mjs";
import { TIMEOUT_PROBE_MS, TIMEOUT_AGENT_MS } from "./timeouts.mjs";

/**
 * Fire each trigger whose env var is set (non-empty after trim), passing the
 * trimmed value to its handler. Handlers run fire-and-forget — the extension
 * must let joinSession() return before issuing session RPC — so a rejection is
 * routed to onError(label, err) instead of becoming an unhandled rejection. Any
 * failure from onError itself (it may be async, e.g. session.log) is swallowed
 * for the same reason. Pure and host-agnostic so the dispatch logic is unit-testable.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Array<{ env: string, label: string, run: (value: string) => unknown | Promise<unknown> }>} triggers
 * @param {{ onError?: (label: string, err: unknown) => unknown | Promise<unknown> }} [opts]
 */
export function dispatchEnvTriggers(env, triggers, { onError } = {}) {
  for (const trigger of triggers) {
    const raw = env[trigger.env];
    if (!raw || raw.trim().length === 0) continue;
    void Promise.resolve()
      .then(() => trigger.run(raw.trim()))
      .catch(async (err) => {
        try {
          await onError?.(trigger.label, err);
        } catch {
          // Secondary reporting failure (e.g. session.log rejected) in a
          // fire-and-forget probe — swallow so it can't surface as an unhandled
          // rejection, which is exactly what this helper promises to prevent.
        }
      });
  }
}

/**
 * Single-spec probe measuring the end-to-end LLM-mediated round-trip on the
 * current host session (Can a handler call session.sendAndWait? Does a reply
 * come back inside the handler?). Creates its own llm-mediated adapter.
 *
 * @param {object} session
 * @param {string} prompt
 */
export async function runEchoProbe(session, prompt) {
  const runId = newRunId();
  const adapter = createLlmMediatedAdapter({ session });
  await session.log(
    `ghcp-maestro/${runId}: echo probe (adapter=${adapter.name}, prompt=${JSON.stringify(prompt)})`,
  );
  const t0 = Date.now();
  const result = await spawn(
    { prompt, agent: "echo", id: `${runId}-echo`, timeoutMs: TIMEOUT_PROBE_MS },
    { adapter },
  );
  const elapsed = Date.now() - t0;
  if (result.status === "ok") {
    const text = (result.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: echo ok in ${elapsed}ms; reply chars=${text.length}; preview=${JSON.stringify(text.slice(0, 120))}`,
    );
  } else {
    await session.log(
      `ghcp-maestro/${runId}: echo ${result.status} in ${elapsed}ms: ${result.error ?? "(no error message)"}`,
      { level: "warning" },
    );
  }
}

/**
 * Calls session.rpc.agentRegistry.spawn() with a minimal payload to find out
 * whether the controller-local spawn gate is open in our context. When the gate
 * is closed the SDK returns a JSON-RPC MethodNotFound — so we report exactly what
 * came back without throwing.
 *
 * @param {object} session
 * @param {string} prompt
 */
export async function runAgentRegistrySpawnProbe(session, prompt) {
  const runId = newRunId();
  await session.log(
    `ghcp-maestro/${runId}: agentRegistry.spawn probe starting (prompt=${JSON.stringify(prompt)})`,
  );
  const cwd = process.env.COPILOT_CLI_CWD ?? process.cwd();
  const t0 = Date.now();
  try {
    const rpc = session.rpc;
    if (!rpc?.agentRegistry?.spawn) {
      await session.log(
        `ghcp-maestro/${runId}: session.rpc.agentRegistry.spawn is undefined; SDK surface missing`,
        { level: "warning" },
      );
      return;
    }
    const result = await rpc.agentRegistry.spawn({
      cwd,
      name: `ghcp-maestro-probe-${runId}`,
      initialPrompt: prompt,
    });
    const elapsed = Date.now() - t0;
    await session.log(
      `ghcp-maestro/${runId}: agentRegistry.spawn returned kind=${result?.kind} in ${elapsed}ms — ${JSON.stringify(result).slice(0, 400)}`,
    );
  } catch (err) {
    const elapsed = Date.now() - t0;
    await session.log(
      `ghcp-maestro/${runId}: agentRegistry.spawn threw after ${elapsed}ms: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
      { level: "warning" },
    );
  }
}

/**
 * Drives the standalone CopilotClient adapter end-to-end with a single spec. On
 * success the reply text is logged back into the host session. Failure surfaces
 * the adapter's error message verbatim so we know whether nested Copilot CLI
 * spawn / auth / RPC works in this environment. The standalone adapter is shared
 * (a process singleton owned by the caller) so it is injected here.
 *
 * @param {object} session
 * @param {string} prompt
 * @param {import("./spawn.mjs").SubagentAdapter} adapter
 */
export async function runPongProbe(session, prompt, adapter) {
  const runId = newRunId();
  await session.log(
    `ghcp-maestro/${runId}: pong probe (adapter=${adapter.name}, prompt=${JSON.stringify(prompt)})`,
  );
  const t0 = Date.now();
  const result = await spawn(
    { prompt, agent: "pong", id: `${runId}-pong`, timeoutMs: TIMEOUT_AGENT_MS },
    { adapter },
  );
  const elapsed = Date.now() - t0;
  if (result.status === "ok") {
    const text = (result.output?.text ?? "").trim();
    await session.log(
      `ghcp-maestro/${runId}: pong ok in ${elapsed}ms; childSessionId=${result.output?.sessionId ?? "?"}; chars=${text.length}; preview=${JSON.stringify(text.slice(0, 200))}`,
    );
  } else {
    await session.log(
      `ghcp-maestro/${runId}: pong ${result.status} in ${elapsed}ms: ${result.error ?? "(no error message)"}`,
      { level: "warning" },
    );
  }
}
