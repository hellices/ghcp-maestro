// Run view-model — pure projection of RunUiEvents into a render-ready snapshot.
//
// Surface-neutral and vscode-free so it unit-tests under `node --test`. The VS
// Code surface feeds it through the UI sink and renders snapshots into the
// TreeView and Webview; the model owns no I/O, only state + change notification.
//
// Recognised event types:
//   run.started    { runId, payload?: { task } }
//   phase.started  { runId, phase }
//   agent.started  { runId, phase, agentId, payload?: { prompt, model, startedAt } }
//   agent.tool     { runId, phase, agentId, payload: { tool, status?, durationMs? } }
//   agent.finished { runId, phase, agentId, payload: { status, output?, error?, tokens?, startedAt?, finishedAt? } }
//   run.finished   { runId, payload?: { status } }

const DONE_STATUSES = new Set(["ok", "complete", "done", "success"]);
const FAILED_STATUSES = new Set(["error", "failed", "timeout", "aborted", "stopped", "cancelled", "canceled"]);

function newAgent(agentId) {
  return {
    id: agentId,
    status: "queued",
    model: undefined,
    prompt: undefined,
    output: undefined,
    error: undefined,
    tokens: undefined,
    tools: [],
    toolCount: 0,
    startedAt: undefined,
    finishedAt: undefined,
    durationMs: undefined,
  };
}

/**
 * @returns {{
 *   apply: (event: import("../../core/ports.mjs").RunUiEvent) => void,
 *   snapshot: () => { runs: Array<object> },
 *   agentDetail: (runId: string, phase: string, agentId: string) => object | undefined,
 *   subscribe: (cb: () => void) => (() => void),
 * }}
 */
export function createRunViewModel() {
  /** insertion-ordered run map */
  const runs = new Map();
  const listeners = new Set();

  const ensureRun = (runId) => {
    if (!runs.has(runId)) {
      runs.set(runId, { id: runId, status: "running", task: undefined, startedAt: Date.now(), finishedAt: undefined, phases: new Map() });
    }
    return runs.get(runId);
  };
  const ensurePhase = (run, phase) => {
    if (phase == null) return undefined;
    if (!run.phases.has(phase)) run.phases.set(phase, { name: phase, agents: new Map() });
    return run.phases.get(phase);
  };
  const ensureAgent = (phaseObj, agentId) => {
    if (agentId == null) return undefined;
    if (!phaseObj.agents.has(agentId)) phaseObj.agents.set(agentId, newAgent(agentId));
    return phaseObj.agents.get(agentId);
  };

  const emit = () => {
    for (const cb of listeners) cb();
  };

  const normaliseStatus = (raw) => {
    if (DONE_STATUSES.has(raw)) return raw === "ok" ? "ok" : raw;
    if (FAILED_STATUSES.has(raw)) return raw;
    return raw || "unknown";
  };

  const apply = (event) => {
    if (!event || event.runId == null) return;
    const run = ensureRun(event.runId);
    const p = event.payload ?? {};

    switch (event.type) {
      case "run.started":
        if (p.task != null) run.task = p.task;
        run.status = "running";
        break;
      case "run.finished":
        run.status = p.status ?? "complete";
        run.finishedAt = Date.now();
        break;
      case "phase.started":
        ensurePhase(run, event.phase);
        break;
      case "agent.started": {
        const agent = ensureAgent(ensurePhase(run, event.phase), event.agentId);
        if (agent) {
          agent.status = "running";
          if (p.prompt != null) agent.prompt = p.prompt;
          if (p.model != null) agent.model = p.model;
          if (p.startedAt != null) agent.startedAt = p.startedAt;
        }
        break;
      }
      case "agent.tool": {
        const agent = ensureAgent(ensurePhase(run, event.phase), event.agentId);
        if (agent) {
          agent.tools.push({ tool: p.tool, status: p.status, durationMs: p.durationMs });
          agent.toolCount = agent.tools.length;
        }
        break;
      }
      case "agent.finished": {
        const agent = ensureAgent(ensurePhase(run, event.phase), event.agentId);
        if (agent) {
          agent.status = normaliseStatus(p.status);
          if (p.output != null) agent.output = p.output;
          if (p.error != null) agent.error = p.error;
          if (p.tokens != null) agent.tokens = p.tokens;
          if (p.startedAt != null) agent.startedAt = p.startedAt;
          if (p.finishedAt != null) agent.finishedAt = p.finishedAt;
          if (agent.startedAt != null && agent.finishedAt != null) {
            agent.durationMs = agent.finishedAt - agent.startedAt;
          }
        }
        break;
      }
      default:
        break;
    }
    emit();
  };

  const phaseCounts = (agents) => {
    const counts = { total: agents.length, done: 0, failed: 0, running: 0 };
    for (const a of agents) {
      if (DONE_STATUSES.has(a.status)) counts.done += 1;
      else if (FAILED_STATUSES.has(a.status)) counts.failed += 1;
      else if (a.status === "running") counts.running += 1;
    }
    return counts;
  };

  const snapshotAgent = (a) => ({ ...a, tools: a.tools.map((t) => ({ ...t })) });

  const snapshot = () => {
    // newest run first for the TUI list
    const ordered = [...runs.values()].reverse();
    return {
      runs: ordered.map((run) => {
        const phases = [...run.phases.values()].map((phase) => {
          const agents = [...phase.agents.values()].map(snapshotAgent);
          return { name: phase.name, counts: phaseCounts(agents), agents };
        });
        const allAgents = phases.flatMap((ph) => ph.agents);
        return {
          id: run.id,
          status: run.status,
          task: run.task,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          counts: phaseCounts(allAgents),
          phases,
        };
      }),
    };
  };

  const agentDetail = (runId, phase, agentId) => {
    const run = runs.get(runId);
    const phaseObj = run?.phases.get(phase);
    const agent = phaseObj?.agents.get(agentId);
    return agent ? snapshotAgent(agent) : undefined;
  };

  const subscribe = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  return { apply, snapshot, agentDetail, subscribe };
}
