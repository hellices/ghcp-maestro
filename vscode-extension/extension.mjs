// VS Code composition root for the ghcp-maestro surface.
//
// This is the only vscode-coupled module (loaded by the extension host, not by
// `node --test`). It wires surface-neutral, unit-tested pieces — the chat
// participant, run view-model, tree provider, console panel, and runtime bridge
// — to VS Code primitives. Keep logic out of here; this file is composition and
// adaptation only.

import * as vscode from "vscode";
import { createMaestroParticipant } from "./chat/participant.mjs";

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
 * Acknowledging RuntimePort: confirms the command in chat. The fan-out bridge
 * (standalone adapter + copilot binary path resolution) and the live run views
 * replace this in the runtime-bridge wiring task.
 * @returns {import("../extensions/ghcp-maestro/runtime/ports.mjs").RuntimePort}
 */
function createChatAckRuntimePort() {
  return {
    runCommand: async ({ subcommand, args }, ctx) => {
      ctx?.logPort?.info(
        `Started \`${subcommand}\`${args ? ` — ${args}` : ""}. Watch progress in the Maestro panel.`,
      );
    },
    resumeRun: async () => {},
    stopRun: async () => {},
  };
}

export function activate(context) {
  const runtimePort = createChatAckRuntimePort();
  const maestro = createMaestroParticipant({ runtimePort });

  const participant = vscode.chat.createChatParticipant(
    "ghcp-maestro.workflow",
    async (request, _chatContext, stream, _token) => {
      const logPort = streamLogPort(stream);
      const text = request.command ? `${request.command} ${request.prompt}` : request.prompt;
      await maestro.handleRequest(text, { logPort });
    },
  );
  context.subscriptions.push(participant);
}

export function deactivate() {}
