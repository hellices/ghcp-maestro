// LogPort adapter over a VS Code chat response stream.
//
// vscode-free: the stream is duck-typed ({ markdown(text) }) so this unit-tests
// without the extension host. The composition root passes the real
// ChatResponseStream.

/**
 * @param {{ stream: { markdown: (text: string) => void } }} deps
 * @returns {import("../../extensions/ghcp-maestro/runtime/ports.mjs").LogPort}
 */
export function createVsCodeLogPort({ stream }) {
  return {
    info: (m) => stream.markdown(`maestro: ${m}\n\n`),
    warn: (m) => stream.markdown(`⚠️ maestro: ${m}\n\n`),
    error: (m) => stream.markdown(`❌ maestro: ${m}\n\n`),
  };
}
