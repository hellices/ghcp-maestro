// Surface-agnostic /maestro subcommand dispatch.
//
// Extracted from extension.mjs so both the GHCP CLI surface and the VS Code
// surface share one parse/dispatch contract — no behaviour drift between them.
// The router owns only control flow (parse head/tail, validate, route); every
// user-facing message stays surface-owned via the semantic callbacks so each
// surface renders through its own channel (session.log vs chat stream).

/**
 * @typedef {Object} MaestroSubcommand
 * @property {string} name
 * @property {string|false} [needsArg] - human label for the required argument, or false
 * @property {boolean} [background] - fire-and-forget (return immediately) vs await
 * @property {(arg: string) => unknown | Promise<unknown>} run
 */

/**
 * @param {Object} opts
 * @param {MaestroSubcommand[]} opts.subcommands
 * @param {() => unknown | Promise<unknown>} opts.onHelp
 * @param {(head: string) => unknown | Promise<unknown>} opts.onUnknown
 * @param {(sc: MaestroSubcommand) => unknown | Promise<unknown>} opts.onMissingArg
 * @param {(sc: MaestroSubcommand, err: unknown) => unknown | Promise<unknown>} opts.onBackgroundError
 * @returns {{ dispatch: (input: string) => Promise<void> }}
 */
export function createMaestroRouter({
  subcommands,
  onHelp,
  onUnknown,
  onMissingArg,
  onBackgroundError,
}) {
  return {
    async dispatch(input) {
      const arg = (input ?? "").trim();
      if (arg === "" || arg === "help" || arg === "--help" || arg === "-h") {
        await onHelp();
        return;
      }
      const spaceIdx = arg.indexOf(" ");
      const head = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
      const tail = spaceIdx === -1 ? "" : arg.slice(spaceIdx + 1).trim();
      const sc = subcommands.find((c) => c.name === head);
      if (!sc) {
        await onUnknown(head);
        return;
      }
      if (sc.name === "help") {
        await onHelp();
        return;
      }
      if (sc.needsArg && !tail) {
        await onMissingArg(sc);
        return;
      }
      if (sc.background) {
        // Fire-and-forget: return at once so the session/chat stays free while
        // the run fans out. A detached rejection is reported, never unhandled.
        Promise.resolve()
          .then(() => sc.run(tail))
          .catch((err) => onBackgroundError(sc, err));
        return;
      }
      await sc.run(tail);
    },
  };
}
