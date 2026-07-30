// File-based control channel for the maestro-top viewer (issue #46 P2).
//
// The viewer is a separate process from the runtime, so intervening in a run
// crosses a process boundary. A control directory inside the run dir is the
// simplest crash-safe channel: the TUI atomically writes one JSON request per
// agent (`control/<agentId>.json`), and the runtime drains the directory
// between poll ticks, applying each request through the run registry's
// per-agent AbortControllers. No sockets, no platform divergence, and a stale
// request simply gets cleaned up with the run dir.
//
// Honest scope note: child sessions are single-prompt today, so "intervene"
// means stop — there is no mid-turn conversation to inject into. Richer
// actions (retry-with-guidance, next-phase notes) can reuse this channel.

import { join, basename } from "node:path";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { writeJsonAtomic } from "./run-store.mjs";

function assertSafeAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("control: agentId must be a non-empty string");
  }
  if (/[/\\]/.test(agentId) || agentId.includes("..") || agentId.includes("\0")) {
    throw new Error(`control: unsafe agentId ${JSON.stringify(agentId)}`);
  }
}

/**
 * Write one control request for an agent (viewer side). Atomic; the latest
 * request for an agent wins. `action` is currently only "stop".
 *
 * @param {string} runDir
 * @param {{ agentId: string, action: string }} request
 */
export async function requestAgentControl(runDir, request) {
  assertSafeAgentId(request?.agentId);
  const dir = join(runDir, "control");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, `${request.agentId}.json`), {
    ts: Date.now(),
    agentId: request.agentId,
    action: request.action,
  });
}

/**
 * Drain the control directory (runtime side): read every `*.json` request,
 * delete it, and return the parsed requests. Unparseable files are removed
 * too (a torn write must not poison every later tick); non-JSON files are
 * left alone. Missing dir → [].
 *
 * @param {string} runDir
 * @returns {Promise<Array<{ agentId: string, action: string, ts?: number }>>}
 */
export async function consumeControlRequests(runDir) {
  const dir = join(runDir, "control");
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const requests = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.agentId === "string" && typeof parsed.action === "string") {
        // never trust the file body over its filename for path purposes
        requests.push({ ...parsed, agentId: basename(name, ".json") });
      }
    } catch {
      // torn/invalid — fall through to removal
    }
    await rm(file, { force: true });
  }
  return requests;
}

/**
 * Apply drained control requests through a run registry. Only "stop" is
 * understood; anything else is ignored (forward compatibility). Returns the
 * agent ids whose live controller was actually aborted.
 *
 * @param {Array<{ agentId: string, action: string }>} requests
 * @param {{ runId: string, registry: { abortAgent: (runId: string, agentId: string, reason?: unknown) => boolean } }} opts
 * @returns {string[]}
 */
export function applyControlRequests(requests, { runId, registry }) {
  const applied = [];
  for (const req of requests ?? []) {
    if (req.action !== "stop") continue;
    if (registry.abortAgent(runId, req.agentId)) applied.push(req.agentId);
  }
  return applied;
}
