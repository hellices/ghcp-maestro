// VS Code composition root for the ghcp-maestro surface.
//
// This is the only vscode-coupled module (loaded by the extension host, not by
// `node --test`). It wires surface-neutral, unit-tested pieces — the chat
// participant, run view-model, tree provider, console panel, UI sink, and the
// runtime bridge over the shared core — to VS Code primitives by injection.
// Keep logic out of here; this file is composition and adaptation only.

import * as vscode from "vscode";
import { spawn, DEFAULT_CONCURRENCY } from "../core/spawn.mjs";
import { createStandaloneClientAdapter } from "../core/adapters/standalone-client.mjs";
import { buildPlanPrompt, parseAndValidatePlan } from "../core/plan.mjs";
import { buildSynthPrompt } from "../core/synth.mjs";
import { createMaestroParticipant } from "./chat/participant.mjs";
import { createRunViewModel } from "./state/run-view-model.mjs";
import { createVsCodeUiSink } from "./adapters/vscode-ui-sink.mjs";
import { createVsCodeCancellationPort } from "./adapters/vscode-cancellation-port.mjs";
import { createCopilotRuntime } from "./adapters/copilot-runtime.mjs";
import { createRuntimeBridge } from "./runtime-bridge.mjs";
import { createRunsTreeProvider } from "./views/runs-tree-provider.mjs";
import { createConsolePanel } from "./views/console-panel.mjs";

const DEFAULT_MODEL = "claude-sonnet-4.5";
const DEFAULT_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

function resolveModel() {
  const configured = vscode.workspace.getConfiguration("maestro").get("model");
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return DEFAULT_MODEL;
}

function resolvePositiveNumber(key, fallback) {
  const raw = vscode.workspace.getConfiguration("maestro").get(key);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Adapt a chat response stream to the surface-neutral LogPort (per-turn ack). */
function streamLogPort(stream) {
  return {
    info: (m) => stream.markdown(`${m}\n\n`),
    warn: (m) => stream.markdown(`⚠️ ${m}\n\n`),
    error: (m) => stream.markdown(`❌ ${m}\n\n`),
  };
}

/** Adapt an OutputChannel to a LogPort for detached run logs (survives the turn). */
function channelLogPort(channel) {
  return {
    info: (m) => channel.appendLine(`[info] ${m}`),
    warn: (m) => channel.appendLine(`[warn] ${m}`),
    error: (m) => channel.appendLine(`[error] ${m}`),
  };
}

/**
 * Resolve the Copilot CLI binary. Inside the VS Code extension host
 * `process.execPath` is Electron, not copilot, so the standalone adapter cannot
 * infer it — we surface a `maestro.copilotPath` setting and seed the env var the
 * adapter reads.
 */
function resolveCopilotPath() {
  const configured = vscode.workspace.getConfiguration("maestro").get("copilotPath");
  if (configured) {
    process.env.COPILOT_CLI_PATH = configured;
    return configured;
  }
  return process.env.COPILOT_CLI_PATH;
}

export function activate(context) {
  const output = vscode.window.createOutputChannel("Maestro");
  context.subscriptions.push(output);

  const model = createRunViewModel();
  const uiSink = createVsCodeUiSink({ model });

  const cliPath = resolveCopilotPath();
  const modelId = resolveModel();
  const planTimeoutMs = resolvePositiveNumber("planTimeoutMs", DEFAULT_PLAN_TIMEOUT_MS);
  const agentTimeoutMs = resolvePositiveNumber("agentTimeoutMs", DEFAULT_AGENT_TIMEOUT_MS);
  output.appendLine(`[info] maestro using model: ${modelId} (planTimeoutMs=${planTimeoutMs}, agentTimeoutMs=${agentTimeoutMs})`);
  const runtime = createCopilotRuntime({
    createAdapter: () =>
      createStandaloneClientAdapter({
        defaultModel: modelId,
        logger: {
          info: (m) => output.appendLine(`[standalone] ${m}`),
          warn: (m) => output.appendLine(`[standalone:warn] ${m}`),
        },
      }),
    spawn,
    buildPlanPrompt,
    parseAndValidatePlan,
    buildSynthPrompt,
    defaultModel: modelId,
    planTimeoutMs,
    agentTimeoutMs,
  });
  context.subscriptions.push({ dispose: () => void runtime.stop?.() });

  const bridge = createRuntimeBridge({
    emit: uiSink.onRunEvent,
    planTask: runtime.planTask,
    runAgent: runtime.runAgent,
    synthesize: runtime.synthesize,
    concurrency: DEFAULT_CONCURRENCY,
    log: channelLogPort(output),
  });

  // Surface wrapper: kick off the fan-out detached so the chat turn returns fast
  // (its response stream closes at turn end); progress flows to the views, not
  // the chat. `workflows` is awaited so its listing reaches the chat reply.
  const runtimePort = {
    runCommand: async (input, ctx) => {
      if (input.subcommand === "workflows") return bridge.runCommand(input, ctx);
      void bridge
        .runCommand(input, ctx)
        .catch((err) => output.appendLine(`[error] run failed: ${err?.message ?? err}`));
      ctx?.logPort?.info(
        `Started \`${input.subcommand}\`${input.args ? ` — ${input.args}` : ""}. Open the **Maestro** panel to watch agents in real time.`,
      );
      if (!cliPath) {
        ctx?.logPort?.warn(
          "No Copilot CLI path configured. Set `maestro.copilotPath` so agents can spawn isolated sessions.",
        );
      }
      vscode.commands.executeCommand("ghcp-maestro.openConsole");
      return { kicked: true };
    },
    resumeRun: bridge.resumeRun,
    stopRun: bridge.stopRun,
    retryAgent: bridge.retryAgent,
  };

  const maestro = createMaestroParticipant({ runtimePort });

  const treeProvider = createRunsTreeProvider({ vscode, model });
  const treeView = vscode.window.createTreeView("maestroRuns", { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView, { dispose: () => treeProvider.dispose?.() });

  const consolePanel = createConsolePanel({
    vscode,
    model,
    context,
    onRetryAgent: (sel) => vscode.commands.executeCommand("ghcp-maestro.retryAgent", sel),
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("ghcp-maestro.openConsole", (sel) => consolePanel.reveal(sel)),
    vscode.commands.registerCommand("ghcp-maestro.retryAgent", async (sel) => {
      if (!sel?.runId) return;
      output.appendLine(`[info] retry ${sel.agentId} in ${sel.runId}/${sel.phase}`);
      await bridge.retryAgent(sel);
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    "ghcp-maestro.workflow",
    async (request, _chatContext, stream, token) => {
      const logPort = streamLogPort(stream);
      const cancellation = createVsCodeCancellationPort(token);
      const text = request.command ? `${request.command} ${request.prompt}` : request.prompt;
      await maestro.handleRequest(text, { logPort, uiSink, cancellation });
    },
  );
  context.subscriptions.push(participant);
}

export function deactivate() {}
