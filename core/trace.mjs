// OTel GenAI-compatible trace export (#32) — zero-deps, pure builder.
//
// Every terminal run writes a `trace.json` next to its manifest: one root
// `invoke_workflow` span plus one `invoke_agent` child span per agent record,
// using the OpenTelemetry GenAI semantic-convention attribute names
// (`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`,
// `error.type`, …). Always-on, same principle as token accounting: it is a
// cheap file write with zero token cost, and runs that don't emit these
// attributes are un-introspectable in modern APM tooling.
//
// This is an OTel-*style* JSON document (attribute-name compatible), not a
// full OTLP payload — post-process it into a real exporter if you need OTLP.
// Note the GenAI semantic conventions are still in Development status
// upstream, so attribute names may drift with the spec.

/**
 * Deterministic hex id from a seed string (FNV-1a folded to `bytes` bytes).
 * Not cryptographic — trace/span ids in a local trace file only need to be
 * stable and unique per run, and determinism keeps the builder pure.
 *
 * @param {string} seed
 * @param {number} bytes - 16 for traceId, 8 for spanId
 * @returns {string}
 */
export function hexId(seed, bytes) {
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; out.length < bytes * 2; round++) {
    const s = `${round}:${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, bytes * 2);
}

const NS_PER_MS = 1_000_000n;

// BigInt conversion: real epoch milliseconds × 1e6 exceed Number.MAX_SAFE_INTEGER
// (~1.7e18 ns), so a float multiply would corrupt the low digits.
function toNanos(ms) {
  return typeof ms === "number" && Number.isFinite(ms)
    ? String(BigInt(Math.round(ms)) * NS_PER_MS)
    : undefined;
}

/**
 * Build the OTel GenAI-style span list for a finished (or stopped/failed) run.
 * Pure: derives everything from the manifest and the cached agent records.
 *
 * @param {{
 *   manifest: { runId: string, workflow?: string, status?: string, startedAt?: number, finishedAt?: number, tokensUsed?: number },
 *   agents: Array<{ agentId: string, spec?: { agent?: string, model?: string }, status?: string, error?: string, startedAt?: number, finishedAt?: number, attempts?: number }>,
 * }} params
 * @returns {{ traceId: string, spans: object[] }}
 */
export function buildTraceSpans({ manifest, agents }) {
  const runId = manifest?.runId ?? "unknown-run";
  const traceId = hexId(runId, 16);
  const rootSpanId = hexId(`${runId}/root`, 8);

  const root = {
    traceId,
    spanId: rootSpanId,
    name: `invoke_workflow ${manifest?.workflow ?? "unknown"}`,
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: toNanos(manifest?.startedAt),
    endTimeUnixNano: toNanos(manifest?.finishedAt),
    attributes: {
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.conversation.id": runId,
      "ghcp_maestro.workflow": manifest?.workflow,
      "ghcp_maestro.run.status": manifest?.status,
      ...(typeof manifest?.tokensUsed === "number"
        ? { "gen_ai.usage.total_tokens": manifest.tokensUsed }
        : {}),
    },
    status: { code: manifest?.status === "error" ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK" },
  };

  const children = (agents ?? [])
    .slice()
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((rec) => {
      const agentName = rec.spec?.agent ?? rec.agentId;
      const failed = rec.status !== undefined && rec.status !== "ok";
      return {
        traceId,
        // "agent/" namespaces the seed so an agent literally named "root"
        // can't collide with the root span id.
        spanId: hexId(`${runId}/agent/${rec.agentId}`, 8),
        parentSpanId: rootSpanId,
        name: `invoke_agent ${agentName}`,
        kind: "SPAN_KIND_CLIENT",
        startTimeUnixNano: toNanos(rec.startedAt),
        endTimeUnixNano: toNanos(rec.finishedAt),
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agentName,
          "gen_ai.conversation.id": runId,
          ...(rec.spec?.model ? { "gen_ai.request.model": rec.spec.model } : {}),
          ...(typeof rec.attempts === "number" ? { "ghcp_maestro.attempts": rec.attempts } : {}),
          "ghcp_maestro.agent.status": rec.status,
          ...(failed ? { "error.type": rec.status } : {}),
        },
        status: failed
          ? { code: "STATUS_CODE_ERROR", ...(rec.error ? { message: rec.error } : {}) }
          : { code: "STATUS_CODE_OK" },
      };
    });

  return { traceId, spans: [root, ...children] };
}
