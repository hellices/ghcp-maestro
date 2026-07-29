#!/usr/bin/env node
// maestro-top — standalone live TUI viewer for ghcp-maestro runs (issue #46).
//
// A separate terminal process, deliberately OUTSIDE the plugin's JSON-RPC
// session: it owns its own stdout, reads only the run-store directory
// (~/.copilot/plugin-data/ghcp-maestro or $GHCP_MAESTRO_DATA_DIR), and never
// writes to it. All view logic lives in core/tui.mjs (pure, unit-tested);
// this file is only the terminal wiring: raw-mode keys, repaint loop, exit.
//
// Usage:
//   maestro-top              follow the most recent active run
//   maestro-top <runId>      follow a specific run
//   maestro-top --all        one-shot overview table of recent runs

import {
  initialTuiState,
  reduceKey,
  renderTui,
  renderRunsOverview,
  mapKeyInput,
} from "../../../core/tui.mjs";
import { resolveTargetRunId, readRunFrame } from "../../../core/tui-data.mjs";
import { listRuns, defaultBaseDir } from "../../../core/run-store.mjs";
import { requestAgentControl } from "../../../core/tui-control.mjs";
import { join } from "node:path";

const POLL_MS = 1000;
const out = process.stdout;
const isTty = Boolean(out.isTTY && process.stdin.isTTY);

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    out.write("usage: maestro-top [runId] [--all]\n");
    return;
  }

  if (args.includes("--all")) {
    const runs = await listRuns({ limit: 20 });
    out.write(renderRunsOverview(runs).join("\n") + "\n");
    return;
  }

  const requested = args.find((a) => !a.startsWith("-"));
  const runId = requested ?? (await resolveTargetRunId());
  if (!runId) {
    out.write("maestro-top: no runs found\n");
    process.exitCode = 1;
    return;
  }

  let state = initialTuiState();
  let lastFrameLines = 0;
  let lastPlainText = "";
  let agentIds = [];

  async function paint() {
    const expandedAgentIds = [...state.expanded].map((i) => agentIds[i]).filter(Boolean);
    const frame = await readRunFrame(runId, { expandedAgentIds });
    if (!frame) {
      cleanup();
      out.write(`maestro-top: run ${runId} not found\n`);
      process.exitCode = 1;
      return false;
    }
    agentIds = (frame.snapshot?.agents ?? []).map((a) => a.specId);
    const lines = renderTui({
      snapshot: frame.snapshot,
      manifest: frame.manifest,
      state,
      events: frame.events,
      width: out.columns ?? 80,
    });
    if (isTty) {
      // repaint in place: cursor home, then clear each line as it is rewritten
      let buf = "\u001b[H";
      for (const line of lines) buf += "\u001b[2K" + line + "\n";
      // blank out leftover lines from a taller previous frame
      for (let i = lines.length; i < lastFrameLines; i++) buf += "\u001b[2K\n";
      out.write(buf);
      lastFrameLines = lines.length;
    } else {
      // non-TTY: append-only, and only when something changed
      const text = lines.join("\n");
      if (text !== lastPlainText) {
        out.write(text + "\n---\n");
        lastPlainText = text;
      }
    }
    return frame.manifest.status === "running";
  }

  function cleanup() {
    if (isTty) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write("\u001b[?25h"); // show cursor
    }
  }

  if (isTty) {
    out.write("\u001b[2J\u001b[H\u001b[?25l"); // clear screen, hide cursor
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      const key = mapKeyInput(chunk);
      if (!key) return;
      if (key === "stopAgent") {
        // side effect, not a state change: drop a stop request into the run's
        // control dir for the selected agent; the runtime poller picks it up
        const agentId = agentIds[state.selected];
        if (agentId) {
          const runDir = join(defaultBaseDir(), "runs", runId);
          requestAgentControl(runDir, { agentId, action: "stop" }).catch(() => {});
        }
        return;
      }
      state = reduceKey(state, key, agentIds.length);
      if (state.quit) {
        cleanup();
        process.exit(0);
      }
      paint().catch(() => {});
    });
  }

  // Follow loop: poll until the run reaches a terminal status. In TTY mode the
  // final frame stays up (with keys live) until the user quits; in non-TTY
  // mode exit after printing it.
  for (;;) {
    const running = await paint();
    if (!running) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!isTty) cleanup();
}

main().catch((err) => {
  process.stderr.write(`maestro-top: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
