// VS Code composition root for the ghcp-maestro surface.
//
// This is the only vscode-coupled module (loaded by the extension host, not by
// `node --test`). It wires surface-neutral, unit-tested pieces — the chat
// participant, run view-model, tree provider, console panel, UI sink — to VS
// Code primitives by injection. Keep logic out of here; this file is
// composition and adaptation only. The real fan-out bridge replaces the ack
// runtime port in the runtime-bridge task.

import * as vscode from "vscode";
import { createMaestroParticipant } from "./chat/participant.mjs";
import { createRunViewModel } from "./state/run-view-model.mjs";
import { createVsCodeUiSink } from "./adapters/vscode-ui-sink.mjs";
import { createRunsTreeProvider } from "./views/runs-tree-provider.mjs";
import { createConsolePanel } from "./views/console-panel.mjs";

/**
 * Adapt a chat response stream to the surface-neutral LogPort so the shared
 * router/participant can report without knowing about VS Code.
 * @param {import("vscode").ChatResponseStream} stream
 */
function streamLogPort(stream) {
  return {
    info: (m) => stream.markdown(`${m}\n\n`),
    warn: (m) => stream.markdown(`⚠️ ${m}\n\n`),
    error: (m) => stream.markdown(`❌ ${m}\n\n`),
  };
}

/**
 * Acknowledging RuntimePort: confirms the command in chat and seeds a run node
 * so the tree/console reflect the kicked-off run. The fan-out bridge (standalone
 * adapter + copilot binary path resolution) replaces this in the bridge task.
 * @returns {import("../extensions/ghcp-maestro/runtime/ports.mjs").RuntimePort}
 */
function createChatAckRuntimePort() {
  let seq = 0;
  return {
    runCommand: async ({ subcommand, args }, ctx) => {
      const runId = `${subcommand}-${Date.now()}-${seq++}`;
      ctx?.uiSink?.onRunEvent({
        type: "run.started",
        runId,
        payload: { task: args || subcommand },
      });
      ctx?.logPort?.info(
        `Started \`${subcommand}\`${args ? ` — ${args}` : ""}. Open the Maestro panel to watch progress.`,
      );
    },
    resumeRun: async () => {},
    stopRun: async () => {},
  };
}

export function activate(context) {
  const model = createRunViewModel();
  const uiSink = createVsCodeUiSink({ model });
  const runtimePort = createChatAckRuntimePort();
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
    vscode.commands.registerCommand("ghcp-maestro.retryAgent", (sel) => {
      vscode.window.showInformationMessage(
        `Retry queued for ${sel?.agentId ?? "agent"} (wired to the fan-out bridge).`,
      );
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    "ghcp-maestro.workflow",
    async (request, _chatContext, stream, _token) => {
      const logPort = streamLogPort(stream);
      const text = request.command ? `${request.command} ${request.prompt}` : request.prompt;
      await maestro.handleRequest(text, { logPort, uiSink });
    },
  );
  context.subscriptions.push(participant);
}

export function deactivate() {}
