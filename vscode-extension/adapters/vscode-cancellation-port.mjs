// CancellationPort adapter over a VS Code CancellationToken.
//
// vscode-free: the token is duck-typed so this unit-tests without the extension
// host. The composition root passes the real CancellationToken from a chat
// request or a webview action.

/**
 * @param {{ isCancellationRequested?: boolean, onCancellationRequested?: (cb: () => void) => unknown }} [token]
 * @returns {import("../../extensions/ghcp-maestro/runtime/ports.mjs").CancellationPort}
 */
export function createVsCodeCancellationPort(token) {
  return {
    isCancelled: () => token?.isCancellationRequested === true,
    onCancel: (cb) => {
      token?.onCancellationRequested?.(cb);
    },
  };
}
