// VS Code chat participant entry — surface-thin. Reuses the shared maestro
// router and help renderer so /maestro behaves identically to the GHCP CLI.
// This module is intentionally vscode-free so it is unit-testable under
// `node --test`; the per-request stream/token are adapted to a LogPort by the
// composition root (extension.mjs) and passed in.

import { createMaestroRouter } from "../../core/maestro-router.mjs";
import { renderMaestroHelp } from "../../core/help.mjs";

/**
 * Subcommands exposed on the VS Code surface, bound to the per-request ctx so
 * the bridge can stream an acknowledgement and seed the run views. The bridge's
 * runCommand returns fast (kick-off + ack); the long fan-out runs detached and
 * reports through the UI sink, not the chat stream (which closes with the turn).
 * `run`/`workflows` mirror the saved-workflow commands.
 *
 * @param {import("../../core/ports.mjs").RuntimePort} runtimePort
 * @param {{ logPort?: import("../../core/ports.mjs").LogPort, uiSink?: import("../../core/ports.mjs").UiSinkPort }} ctx
 */
function buildSubcommands(runtimePort, ctx) {
  const cmd = (subcommand) => (args) => runtimePort.runCommand({ subcommand, args }, ctx);
  return [
    {
      name: "task",
      needsArg: "task description",
      summary: "Decompose a natural-language task into subtasks, fan out in parallel, then synth.",
      run: cmd("task"),
    },
    {
      name: "brainstorm",
      needsArg: "topic",
      summary: "Brainstorm a topic from multiple lenses in parallel, then synth the top actions.",
      run: cmd("brainstorm"),
    },
    {
      name: "run",
      needsArg: "name [args]",
      summary: "Run a saved workflow by name (args are JSON or plain text).",
      run: cmd("run"),
    },
    {
      name: "workflows",
      needsArg: false,
      summary: "List discovered saved workflows.",
      run: cmd("workflows"),
    },
    { name: "help", needsArg: false, summary: "This help.", run: () => {} },
  ];
}

const LEADING_INVOCATION = /^\s*[@/]?maestro\b\s*/i;

/**
 * @param {Object} opts
 * @param {import("../../core/ports.mjs").RuntimePort} opts.runtimePort
 * @returns {{ handleRequest: (text: string, ctx?: { logPort?: import("../../core/ports.mjs").LogPort, uiSink?: import("../../core/ports.mjs").UiSinkPort }) => Promise<void> }}
 */
export function createMaestroParticipant({ runtimePort }) {
  return {
    async handleRequest(text, ctx = {}) {
      const log = ctx.logPort ?? { info() {}, warn() {}, error() {} };
      const subcommands = buildSubcommands(runtimePort, ctx);
      const router = createMaestroRouter({
        subcommands,
        onHelp: () => log.info(renderMaestroHelp(subcommands)),
        onUnknown: (head) =>
          log.warn(`unknown subcommand '${head}'. Try /maestro help for the list.`),
        onMissingArg: (sc) =>
          log.warn(`/maestro ${sc.name} requires a ${sc.needsArg}. Example: /maestro ${sc.name} <${sc.needsArg}>`),
        onBackgroundError: (sc, err) =>
          log.error(`${sc.name} failed: ${err?.message ?? err}`),
      });
      const stripped = (text ?? "").replace(LEADING_INVOCATION, "");
      await router.dispatch(stripped);
    },
  };
}
