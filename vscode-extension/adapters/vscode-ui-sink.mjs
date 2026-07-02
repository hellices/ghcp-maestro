// VS Code UI sink adapter — implements UiSinkPort by feeding the run view-model.
//
// The adapter is the seam between core-domain RunUiEvents and the VS Code UI:
// it forwards events into the (vscode-free) view-model and lets an optional
// onChange callback drive batched re-renders of the TreeView/Webview. Keeping
// the translation here means the core never imports VS Code and the view-model
// never imports VS Code either.

/**
 * @param {Object} opts
 * @param {ReturnType<import("../state/run-view-model.mjs").createRunViewModel>} opts.model
 * @param {() => void} [opts.onChange] - invoked after each applied event (UI refresh hook)
 * @returns {import("../../core/ports.mjs").UiSinkPort}
 */
export function createVsCodeUiSink({ model, onChange }) {
  return {
    onRunEvent: (event) => {
      model.apply(event);
      if (onChange) onChange();
    },
  };
}
