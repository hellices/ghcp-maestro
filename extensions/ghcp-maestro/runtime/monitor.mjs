// Live run monitor (issue #2). Pure aggregator: turns per-agent progress events
// into a progress snapshot + compact dashboard string and renders it through an
// injected sink, throttling high-frequency streaming updates. No SDK / IO here —
// the caller wires `render(text, snapshot)` to either an ephemeral host log or a
// RunStore progress.json write.

const GLYPH = {
  pending: "·",
  running: "⠿",
  streaming: "⠿",
  tool: "⠿",
  done: "✓",
  failed: "✗",
};

/**
 * @param {{
 *   label: string,
 *   render: (text: string, snapshot: object) => void,
 *   now?: () => number,
 *   throttleMs?: number,
 * }} opts
 */
export function createMonitor(opts) {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? 500;
  const label = opts.label ?? "ghcp-maestro";
  const agents = new Map(); // specId -> { id, agent, state, bytes, tokens, startTs, lastTs }
  let lastRenderTs = -Infinity;

  function snapshot() {
    const t = now();
    const agentsList = [...agents.values()].map((a) => ({
      specId: a.id,
      agent: a.agent,
      state: a.state,
      elapsedMs: t - a.startTs,
      bytes: a.bytes,
      tokens: a.tokens,
      ...(a.tool ? { tool: a.tool } : {}),
    }));
    const done = agentsList.filter((a) => a.state === "done" || a.state === "failed").length;
    const maxElapsedMs = agentsList.reduce((m, a) => Math.max(m, a.elapsedMs), 0);
    const totalTokens = agentsList.reduce((m, a) => m + a.tokens, 0);
    return {
      label,
      agents: agentsList,
      done,
      total: agentsList.length,
      maxElapsedMs,
      totalTokens,
      updatedAt: t,
    };
  }

  function doRender() {
    lastRenderTs = now();
    try {
      const snap = snapshot();
      opts.render(renderDashboard(snap), snap);
    } catch {
      // rendering is best-effort; never propagate
    }
  }

  function maybeRender(state) {
    if (state === "streaming") {
      if (now() - lastRenderTs >= throttleMs) doRender();
      return;
    }
    doRender();
  }

  return {
    seed(specs) {
      for (const s of specs ?? []) {
        agents.set(s.id, {
          id: s.id,
          agent: s.agent,
          state: "pending",
          bytes: 0,
          tokens: 0,
          startTs: now(),
          lastTs: now(),
        });
      }
    },
    onProgress(evt) {
      const a = agents.get(evt?.specId);
      if (!a) return;
      if (evt.state) a.state = evt.state;
      if (typeof evt.bytes === "number") a.bytes = Math.max(a.bytes, evt.bytes);
      if (typeof evt.tokens === "number") a.tokens += evt.tokens;
      if (evt.tool) a.tool = evt.tool;
      a.lastTs = now();
      maybeRender(a.state);
    },
    settle(specId, ok) {
      const a = agents.get(specId);
      if (!a) return;
      a.state = ok ? "done" : "failed";
      a.lastTs = now();
      doRender();
    },
    flush() {
      doRender();
    },
    snapshot,
    format() {
      return renderDashboard(snapshot());
    },
  };
}

/** Pure: render a progress snapshot into the full dashboard (header + rows). */
export function renderDashboard(snap) {
  const rows = snap.agents.map((a) => {
    const glyph = GLYPH[a.state] ?? "·";
    const secs = `${Math.round(a.elapsedMs / 1000)}s`;
    const bytes = a.bytes ? `  ${kb(a.bytes)}` : "";
    const tool = a.state === "tool" && a.tool ? `  (${a.tool})` : "";
    const tok = a.tokens ? `  ${ktok(a.tokens)} tok` : "";
    return `  ${glyph} ${a.agent}  ${a.state}  ${secs}${bytes}${tool}${tok}`;
  });
  return [renderSummary(snap), ...rows].join("\n");
}

/** Pure: render a progress snapshot into a one-line summary (the header). */
export function renderSummary(snap) {
  const tokTotal = snap.totalTokens ? ` · ${ktok(snap.totalTokens)} tok` : "";
  return `${snap.label} · ${snap.done}/${snap.total} done · ${mmss(snap.maxElapsedMs)}${tokTotal}`;
}

function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function ktok(tokens) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}
