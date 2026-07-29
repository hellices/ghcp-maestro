// TUI view-model for the maestro-top standalone viewer (issue #46).
//
// Pure functions only: a keyboard reducer `(state, key) => state` and renderers
// `(inputs) => lines[]`. No IO, no ANSI escape state, no process access — the
// bin script owns the terminal; this module owns what to draw. Keeping it pure
// makes expand/collapse and the row layout unit-testable without a TTY, and
// keeps the dashboard vocabulary (glyphs, kb/tok formatting) in one place by
// reusing core/monitor.mjs conventions.

const GLYPH = {
  pending: "·",
  running: "⠿",
  streaming: "⠿",
  tool: "⠿",
  done: "✓",
  failed: "✗",
};

/** Fresh interactive state: first row selected, nothing expanded. */
export function initialTuiState() {
  return { selected: 0, expanded: new Set(), quit: false };
}

/**
 * Keyboard reducer. Keys are semantic ("down", "expand", …) — the bin script
 * maps raw terminal bytes to these names. Unknown keys return the state
 * unchanged. `total` is the current agent-row count for clamping.
 *
 * @param {{ selected: number, expanded: Set<number>, quit: boolean }} state
 * @param {string} key
 * @param {number} total
 */
export function reduceKey(state, key, total) {
  switch (key) {
    case "up":
      return { ...state, selected: Math.max(0, state.selected - 1) };
    case "down":
      return { ...state, selected: Math.min(Math.max(0, total - 1), state.selected + 1) };
    case "expand": {
      const expanded = new Set(state.expanded);
      expanded.add(state.selected);
      return { ...state, expanded };
    }
    case "collapse": {
      const expanded = new Set(state.expanded);
      expanded.delete(state.selected);
      return { ...state, expanded };
    }
    case "expandAll": {
      const all = state.expanded.size === total && total > 0;
      return { ...state, expanded: all ? new Set() : new Set(Array.from({ length: total }, (_, i) => i)) };
    }
    case "quit":
      return { ...state, quit: true };
    default:
      return state;
  }
}

/**
 * Render one frame of the follow view.
 *
 * @param {{
 *   snapshot: { label?: string, done: number, total: number, maxElapsedMs: number, totalTokens: number, agents: Array<object> } | undefined,
 *   manifest: { runId: string, workflow: string, status: string, startedAt?: number, finishedAt?: number, tokensUsed?: number } | undefined,
 *   state: ReturnType<typeof initialTuiState>,
 *   events: Record<string, object[]>,
 *   width?: number,
 * }} inputs
 * @returns {string[]}
 */
export function renderTui({ snapshot, manifest, state, events, width = 80 }) {
  const lines = [];
  const agents = snapshot?.agents ?? [];

  // header
  const head = [
    manifest?.runId ?? "?",
    manifest?.workflow ?? "?",
    manifest?.status ?? "?",
    snapshot ? `${snapshot.done}/${snapshot.total} done` : "no progress yet",
    snapshot ? mmss(snapshot.maxElapsedMs) : "",
    snapshot?.totalTokens ? `${ktok(snapshot.totalTokens)} tok` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(truncate(head, width));
  if (snapshot?.label) lines.push(truncate(snapshot.label, width));
  lines.push("");

  // agent rows
  agents.forEach((a, i) => {
    const marker = i === state.selected ? "❯" : " ";
    const glyph = GLYPH[a.state] ?? "·";
    const secs = `${Math.round((a.elapsedMs ?? 0) / 1000)}s`;
    const tool = a.state === "tool" && a.tool ? `  (${a.tool})` : "";
    const bytes = a.bytes ? `  ${kb(a.bytes)}` : "";
    const tok = a.tokens ? `  ${ktok(a.tokens)} tok` : "";
    lines.push(truncate(`${marker} ${glyph} ${a.agent}  ${a.state}  ${secs}${bytes}${tool}${tok}`, width));
    if (state.expanded.has(i)) {
      for (const line of renderEventLines(events?.[a.specId] ?? [], width)) lines.push(line);
    }
  });

  lines.push("");
  lines.push(truncate("↑/↓ select · →/enter expand · ← collapse · a all · q quit", width));
  return lines;
}

/** Render an agent's recent events as indented detail lines. */
function renderEventLines(agentEvents, width) {
  if (!agentEvents.length) return ["      (no events recorded)"];
  return agentEvents.slice(-12).map((e) => {
    const parts = [e.phase ? `[${e.phase}]` : null, e.state ?? "?"];
    if (e.tool) parts.push(`⚙ ${e.tool}`);
    if (typeof e.bytes === "number" && e.bytes > 0) parts.push(kb(e.bytes));
    if (typeof e.tokens === "number" && e.tokens > 0) parts.push(`${ktok(e.tokens)} tok`);
    return truncate(`      ${parts.filter(Boolean).join("  ")}`, width);
  });
}

/**
 * Render the --all overview: one row per run manifest, newest first (the
 * caller passes listRuns output, which is already sorted).
 *
 * @param {Array<{ runId: string, workflow: string, status: string, startedAt?: number, finishedAt?: number, tokensUsed?: number }>} manifests
 * @returns {string[]}
 */
export function renderRunsOverview(manifests) {
  const lines = ["runId · workflow · status · elapsed · tokens"];
  for (const m of manifests ?? []) {
    const elapsed =
      m.startedAt != null ? mmss((m.finishedAt ?? Date.now()) - m.startedAt) : "";
    const tok = m.tokensUsed ? `${ktok(m.tokensUsed)} tok` : "";
    lines.push([m.runId, m.workflow, m.status, elapsed, tok].filter(Boolean).join(" · "));
  }
  return lines;
}

/**
 * Map raw terminal input (a stdin chunk in raw mode) to a semantic reducer
 * key, or undefined for input the TUI ignores. Arrow keys arrive as ANSI CSI
 * sequences; vi-style j/k and Ctrl-C are also honoured.
 *
 * @param {string} input
 * @returns {string | undefined}
 */
export function mapKeyInput(input) {
  switch (input) {
    case "\u001b[A":
    case "k":
      return "up";
    case "\u001b[B":
    case "j":
      return "down";
    case "\u001b[C":
    case "\r":
    case "\n":
      return "expand";
    case "\u001b[D":
      return "collapse";
    case "a":
      return "expandAll";
    case "q":
    case "\u0003":
      return "quit";
    default:
      return undefined;
  }
}

function truncate(line, width) {
  return line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
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
