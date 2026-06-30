// Runs TreeView provider for the Maestro Activity Bar.
//
// Pure projection helpers (flattenTreeRows / rowLabel / rowDescription / rowIcon)
// are vscode-free so they unit-test under `node --test`. The TreeDataProvider
// factory takes `vscode` by injection (never a top-level import) so this module
// stays loadable outside the extension host while still owning the wiring.

/**
 * @typedef {Object} TreeRow
 * @property {"run"|"phase"|"agent"} kind
 * @property {string} id          - stable tree id ("r1", "r1:explore", "r1:explore:a1")
 * @property {string} [runId]
 * @property {string} [phase]
 * @property {string} [agentId]
 * @property {string} [status]
 * @property {string} [task]
 * @property {string} [model]
 * @property {number} [tokens]
 * @property {number} [toolCount]
 * @property {number} [durationMs]
 * @property {{total:number,done:number,failed:number,running:number}} [counts]
 */

/**
 * Flatten a view-model snapshot into a depth-tagged row list.
 * @param {{runs: Array<object>}} snapshot
 * @returns {TreeRow[]}
 */
export function flattenTreeRows(snapshot) {
  const out = [];
  for (const run of snapshot?.runs ?? []) {
    out.push({ kind: "run", id: run.id, runId: run.id, status: run.status, task: run.task, counts: run.counts });
    for (const phase of run.phases ?? []) {
      out.push({
        kind: "phase",
        id: `${run.id}:${phase.name}`,
        runId: run.id,
        phase: phase.name,
        counts: phase.counts,
      });
      for (const agent of phase.agents ?? []) {
        out.push({
          kind: "agent",
          id: `${run.id}:${phase.name}:${agent.id}`,
          runId: run.id,
          phase: phase.name,
          agentId: agent.id,
          status: agent.status,
          model: agent.model,
          tokens: agent.tokens,
          toolCount: agent.toolCount,
          durationMs: agent.durationMs,
        });
      }
    }
  }
  return out;
}

/** @param {TreeRow} row */
export function rowLabel(row) {
  if (row.kind === "run") return row.task || row.id;
  if (row.kind === "phase") return row.phase;
  return row.agentId;
}

function fmtCounts(counts) {
  if (!counts) return "";
  const failed = counts.failed ? ` ✗${counts.failed}` : "";
  return `${counts.done}/${counts.total}${failed}`;
}

function fmtDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** @param {TreeRow} row */
export function rowDescription(row) {
  if (row.kind === "run") return fmtCounts(row.counts);
  if (row.kind === "phase") return fmtCounts(row.counts);
  // agent: dense infra line — model · tokens · tools · time
  const parts = [];
  if (row.model) parts.push(row.model);
  if (row.tokens != null) parts.push(`${row.tokens} tok`);
  if (row.toolCount != null) parts.push(`${row.toolCount} tools`);
  const dur = fmtDuration(row.durationMs);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

const STATUS_ICONS = {
  ok: "pass",
  complete: "pass",
  done: "pass",
  success: "pass",
  running: "loading~spin",
  queued: "circle-outline",
  error: "error",
  failed: "error",
  timeout: "warning",
  unknown: "question",
};

/** @param {TreeRow} row -> a vscode codicon id */
export function rowIcon(row) {
  if (row.kind === "run") return row.status === "running" ? "loading~spin" : "history";
  if (row.kind === "phase") return "layers";
  return STATUS_ICONS[row.status] ?? "circle-outline";
}

/**
 * Build the vscode TreeDataProvider. `vscode` is injected to keep this module
 * importable under node for the pure-helper tests above.
 * @param {{ vscode: typeof import("vscode"), model: ReturnType<import("../state/run-view-model.mjs").createRunViewModel> }} deps
 */
export function createRunsTreeProvider({ vscode, model }) {
  const changeEmitter = new vscode.EventEmitter();

  const provider = {
    onDidChangeTreeData: changeEmitter.event,

    getChildren(element) {
      const snapshot = model.snapshot();
      if (!element) {
        return (snapshot.runs ?? []).map((run) => ({
          kind: "run",
          id: run.id,
          runId: run.id,
          status: run.status,
          task: run.task,
          counts: run.counts,
        }));
      }
      if (element.kind === "run") {
        const run = snapshot.runs.find((r) => r.id === element.runId);
        return (run?.phases ?? []).map((phase) => ({
          kind: "phase",
          id: `${element.runId}:${phase.name}`,
          runId: element.runId,
          phase: phase.name,
          counts: phase.counts,
        }));
      }
      if (element.kind === "phase") {
        const run = snapshot.runs.find((r) => r.id === element.runId);
        const phase = run?.phases.find((p) => p.name === element.phase);
        return (phase?.agents ?? []).map((agent) => ({
          kind: "agent",
          id: `${element.runId}:${element.phase}:${agent.id}`,
          runId: element.runId,
          phase: element.phase,
          agentId: agent.id,
          status: agent.status,
          model: agent.model,
          tokens: agent.tokens,
          toolCount: agent.toolCount,
          durationMs: agent.durationMs,
        }));
      }
      return [];
    },

    getTreeItem(row) {
      const collapsible =
        row.kind === "agent"
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(rowLabel(row), collapsible);
      item.id = row.id;
      item.description = rowDescription(row);
      item.iconPath = new vscode.ThemeIcon(rowIcon(row));
      item.contextValue = row.kind;
      if (row.kind === "agent") {
        item.command = {
          command: "ghcp-maestro.openConsole",
          title: "Open Run Console",
          arguments: [{ runId: row.runId, phase: row.phase, agentId: row.agentId }],
        };
        item.tooltip = `${row.agentId} — ${row.status}`;
      }
      return item;
    },
  };

  const off = model.subscribe(() => changeEmitter.fire());
  provider.dispose = () => {
    off();
    changeEmitter.dispose();
  };
  return provider;
}
