// Pure renderer for the /maestro help text. Extracted from extension.mjs so it
// is unit-testable (extension.mjs runs joinSession at import time). Subcommands
// flagged `hidden: true` (diagnostics like hello/pong) are kept out of the main
// list and grouped under a separate "Diagnostics" section.

/**
 * @param {Array<{ name: string, needsArg?: string|false, summary: string, hidden?: boolean }>} subcommands
 * @param {{ savedWorkflows?: string[] }} [opts]
 * @returns {string}
 */
export function renderMaestroHelp(subcommands, opts = {}) {
  const savedWorkflows = opts.savedWorkflows ?? [];
  const usage = (sc) => (sc.needsArg ? `/maestro ${sc.name} <${sc.needsArg}>` : `/maestro ${sc.name}`);

  const visible = subcommands.filter((sc) => !sc.hidden);
  const hidden = subcommands.filter((sc) => sc.hidden);

  const lines = ["ghcp-maestro: available /maestro subcommands"];
  for (const sc of visible) {
    lines.push(`  ${usage(sc)}`);
    lines.push(`    ${sc.summary}`);
  }

  lines.push("");
  lines.push("Run management:");
  lines.push("  /maestros [runId]             list recent runs, or show one run's live dashboard");
  lines.push("  /maestro-resume <runId>       replay a run; cached agents reused, missing ones rerun");
  lines.push("  /maestro-stop <runId>         mark a run as stopped");

  if (savedWorkflows.length > 0) {
    lines.push("");
    lines.push(`Saved workflows (${savedWorkflows.length}): ${savedWorkflows.join(", ")}`);
    lines.push("  Run with: /maestro run <name> [json-or-text args]");
  }

  if (hidden.length > 0) {
    lines.push("");
    lines.push(DIAGNOSTICS_HEADER);
    for (const sc of hidden) {
      lines.push(`  ${usage(sc)}`);
      lines.push(`    ${sc.summary}`);
    }
  }

  return lines.join("\n");
}

/** Header line that introduces the hidden diagnostic subcommands. */
export const DIAGNOSTICS_HEADER = "Diagnostics (infrastructure smoke tests):";
