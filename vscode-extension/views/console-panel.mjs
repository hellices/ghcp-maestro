// Run Console Webview — the TUI-like, interactive monitoring surface.
//
// `renderConsoleHtml` is a pure function (vscode-free, unit-tested): it emits a
// self-contained document whose client script renders a dense three-pane TUI
// from an embedded snapshot and live `snapshot` messages. The `createConsolePanel`
// factory (vscode injected, never imported at top level) owns the WebviewPanel,
// pushes snapshots on model changes, and relays retry/select messages back out.

/** Serialise state for safe embedding inside a <script> tag. */
function embedJson(value) {
  // `<` guards against a data-driven `</script>` breakout; U+2028/U+2029 are legal
  // in JSON but are JS line terminators inside a <script>, so escape them too.
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Cryptographically-strong nonce for the webview CSP (hex, no import needed). */
function makeNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{runs: Array<object>}} snapshot
 * @param {{runId?: string, phase?: string, agentId?: string}} [selection]
 * @returns {string} full HTML document
 */
export function renderConsoleHtml(snapshot, selection = {}) {
  const state = embedJson({ snapshot: snapshot ?? { runs: [] }, selection: selection ?? {} });
  const nonce = makeNonce();
  const heading =
    snapshot?.runs?.length ? snapshot.runs[0].task || snapshot.runs[0].id : "No runs yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Maestro Run Console</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-editor-font-family, "SF Mono", Menlo, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2;
  }
  header .title { font-weight: 600; }
  .pill { font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); }
  .pill.running { color: var(--vscode-charts-blue); border-color: var(--vscode-charts-blue); }
  .pill.ok, .pill.complete, .pill.done { color: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
  .pill.error, .pill.failed { color: var(--vscode-charts-red); border-color: var(--vscode-charts-red); }
  .grid { display: grid; grid-template-columns: 220px 1fr 320px; height: calc(100vh - 40px); }
  .col { overflow: auto; padding: 8px; }
  .col + .col { border-left: 1px solid var(--vscode-panel-border); }
  .col h3 { margin: 4px 4px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  .item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 6px; cursor: pointer; user-select: none;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .item .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item .meta { opacity: .7; font-size: 11px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
  .dot.running { background: var(--vscode-charts-blue); animation: pulse 1s infinite; }
  .dot.ok, .dot.complete, .dot.done, .dot.success { background: var(--vscode-charts-green); }
  .dot.error, .dot.failed, .dot.timeout { background: var(--vscode-charts-red); }
  .dot.queued { background: var(--vscode-descriptionForeground); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .bar { height: 4px; border-radius: 2px; background: var(--vscode-input-background); overflow: hidden; margin-top: 4px; }
  .bar > span { display: block; height: 100%; background: var(--vscode-charts-green); }
  .infra { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 4px; }
  .infra dt { opacity: .6; }
  .infra dd { margin: 0; font-variant-numeric: tabular-nums; }
  .section { margin: 12px 4px; }
  .section h4 { margin: 0 0 4px; font-size: 11px; opacity: .7; text-transform: uppercase; letter-spacing: .06em; }
  pre.block {
    margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background); border-radius: 6px; max-height: 200px; overflow: auto;
  }
  .tools { display: flex; flex-direction: column; gap: 2px; }
  .tool { display: flex; gap: 8px; align-items: center; font-size: 11px; }
  button {
    font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .empty { opacity: .6; padding: 16px; }
</style>
</head>
<body>
<header>
  <span class="title" id="run-title">${escapeHtml(heading)}</span>
  <span class="pill" id="run-status"></span>
  <span class="meta" id="run-meta" style="opacity:.6"></span>
</header>
<div class="grid">
  <div class="col" id="phases"><h3>Phases</h3><div id="phases-body"></div></div>
  <div class="col" id="agents"><h3>Agents</h3><div id="agents-body"></div></div>
  <div class="col" id="detail"><h3>Infrastructure</h3><div id="detail-body"><div class="empty">Select an agent.</div></div></div>
</div>
<script nonce="${nonce}">window.__MAESTRO_STATE__ = ${state};</script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = window.__MAESTRO_STATE__ || { snapshot: { runs: [] }, selection: {} };

  function statusClass(s) { return (s || "").toLowerCase(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
  function fmtDur(ms) { if (ms == null) return "—"; return ms < 1000 ? ms + "ms" : (ms/1000).toFixed(1) + "s"; }

  function currentRun() {
    const runs = state.snapshot.runs || [];
    return runs.find(r => r.id === state.selection.runId) || runs[0];
  }
  function currentPhase(run) {
    if (!run) return undefined;
    return (run.phases || []).find(p => p.name === state.selection.phase) || run.phases[0];
  }
  function currentAgent(phase) {
    if (!phase) return undefined;
    return (phase.agents || []).find(a => a.id === state.selection.agentId);
  }

  function render() {
    const run = currentRun();
    document.getElementById("run-title").textContent = run ? (run.task || run.id) : "No runs yet";
    const statusEl = document.getElementById("run-status");
    statusEl.textContent = run ? run.status : "";
    statusEl.className = "pill " + (run ? statusClass(run.status) : "");
    document.getElementById("run-meta").textContent = run && run.counts ? (run.counts.done + "/" + run.counts.total + " agents") : "";

    const phase = currentPhase(run);
    renderPhases(run, phase);
    renderAgents(phase);
    renderDetail(currentAgent(phase));
  }

  function renderPhases(run, activePhase) {
    const body = document.getElementById("phases-body");
    if (!run) { body.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    body.innerHTML = "";
    (run.phases || []).forEach(p => {
      const c = p.counts || { total: 0, done: 0 };
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      const el = document.createElement("div");
      el.className = "item" + (activePhase && p.name === activePhase.name ? " active" : "");
      el.innerHTML =
        '<span class="name">' + esc(p.name) + '</span>' +
        '<span class="meta">' + c.done + '/' + c.total + '</span>';
      const wrap = document.createElement("div");
      wrap.appendChild(el);
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.innerHTML = '<span style="width:' + pct + '%"></span>';
      wrap.appendChild(bar);
      el.onclick = () => { state.selection = { runId: run.id, phase: p.name }; render(); };
      body.appendChild(wrap);
    });
  }

  function renderAgents(phase) {
    const body = document.getElementById("agents-body");
    if (!phase) { body.innerHTML = '<div class="empty">No phase selected.</div>'; return; }
    body.innerHTML = "";
    (phase.agents || []).forEach(a => {
      const el = document.createElement("div");
      el.className = "item" + (a.id === state.selection.agentId ? " active" : "");
      const meta = [a.model, a.tokens != null ? a.tokens + " tok" : null, a.toolCount != null ? a.toolCount + " tools" : null, fmtDur(a.durationMs)]
        .filter(Boolean).join(" · ");
      el.innerHTML =
        '<span class="dot ' + statusClass(a.status) + '"></span>' +
        '<span class="name">' + esc(a.id) + '</span>' +
        '<span class="meta">' + esc(meta) + '</span>';
      el.onclick = () => {
        const run = currentRun();
        state.selection = { runId: run.id, phase: phase.name, agentId: a.id };
        render();
      };
      body.appendChild(el);
    });
  }

  function renderDetail(agent) {
    const body = document.getElementById("detail-body");
    if (!agent) { body.innerHTML = '<div class="empty">Select an agent.</div>'; return; }
    let html = '';
    html += '<div style="display:flex;align-items:center;gap:8px;margin:4px">';
    html += '<span class="dot ' + statusClass(agent.status) + '"></span><strong>' + esc(agent.id) + '</strong>';
    html += '<span class="pill ' + statusClass(agent.status) + '" style="margin-left:auto">' + esc(agent.status) + '</span></div>';
    html += '<dl class="infra">';
    html += '<dt>model</dt><dd>' + esc(agent.model || "—") + '</dd>';
    html += '<dt>tokens</dt><dd>' + (agent.tokens != null ? agent.tokens : "—") + '</dd>';
    html += '<dt>tools</dt><dd>' + (agent.toolCount != null ? agent.toolCount : 0) + '</dd>';
    html += '<dt>time</dt><dd>' + fmtDur(agent.durationMs) + '</dd>';
    html += '</dl>';
    if (agent.prompt) html += '<div class="section"><h4>Prompt</h4><pre class="block">' + esc(agent.prompt) + '</pre></div>';
    if (agent.tools && agent.tools.length) {
      html += '<div class="section"><h4>Tool trace</h4><div class="tools">';
      agent.tools.forEach(t => {
        html += '<div class="tool"><span class="dot ' + statusClass(t.status) + '"></span>' + esc(t.tool || "tool") + '<span class="meta" style="margin-left:auto">' + fmtDur(t.durationMs) + '</span></div>';
      });
      html += '</div></div>';
    }
    if (agent.output) html += '<div class="section"><h4>Output</h4><pre class="block">' + esc(agent.output) + '</pre></div>';
    if (agent.error) html += '<div class="section"><h4>Error</h4><pre class="block">' + esc(agent.error) + '</pre></div>';
    html += '<div class="section"><button id="retry">Retry agent</button></div>';
    body.innerHTML = html;
    const retry = document.getElementById("retry");
    if (retry) retry.onclick = () => vscode.postMessage({ type: "retryAgent", runId: state.selection.runId, phase: state.selection.phase, agentId: agent.id });
  }

  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.type === "snapshot") {
      state.snapshot = msg.snapshot || { runs: [] };
      if (msg.selection) state.selection = msg.selection;
      render();
    }
  });

  render();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Create/own the Run Console WebviewPanel. `vscode` injected (no top-level import).
 * @param {{
 *   vscode: typeof import("vscode"),
 *   model: ReturnType<import("../state/run-view-model.mjs").createRunViewModel>,
 *   context: import("vscode").ExtensionContext,
 *   onRetryAgent?: (sel: {runId:string, phase:string, agentId:string}) => void,
 * }} deps
 */
export function createConsolePanel({ vscode, model, context, onRetryAgent }) {
  let panel = null;
  let selection = {};
  let off = null;

  const post = () => {
    if (panel) panel.webview.postMessage({ type: "snapshot", snapshot: model.snapshot(), selection });
  };

  const reveal = (sel) => {
    if (sel) selection = { ...selection, ...sel };
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "maestroConsole",
        "Maestro Run Console",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = renderConsoleHtml(model.snapshot(), selection);
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === "retryAgent" && onRetryAgent) onRetryAgent(msg);
      });
      off = model.subscribe(post);
      panel.onDidDispose(() => {
        if (off) off();
        off = null;
        panel = null;
      });
    } else {
      panel.reveal(vscode.ViewColumn.Active);
    }
    post();
  };

  context.subscriptions.push({
    dispose: () => {
      if (off) off();
      if (panel) panel.dispose();
    },
  });

  return { reveal, render: post };
}
