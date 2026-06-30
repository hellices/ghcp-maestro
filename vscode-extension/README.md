# ghcp-maestro (VS Code)

Multi-agent workflow runtime for VS Code Chat. Decompose a natural-language task,
fan out isolated Copilot agents in parallel, and watch them in a TUI-like Run
Console — all inside VS Code.

This is the **VS Code surface** of [ghcp-maestro](../README.md). It shares the
runtime core with the GitHub Copilot CLI plugin and is installed separately.

## Features

- **`@maestro` chat participant** — `task`, `brainstorm`, `run`, `workflows`,
  identical to the CLI.
- **Runs view** (Activity Bar) — run → phase → agent tree with live status icons
  and a `model · tokens · tools · time` line per agent.
- **Run Console** (webview) — three panes (Phases / Agents / Infrastructure) with
  live updates, click-to-drill into an agent's prompt, tool trace, and output,
  plus per-agent retry. No external browser.

## Setup

The VS Code extension host runs on Electron/Node, not the Copilot binary, so
point the extension at the Copilot CLI:

```jsonc
// settings.json
{ "maestro.copilotPath": "/absolute/path/to/copilot" }
```

Falls back to the `COPILOT_CLI_PATH` environment variable when empty. Run logs
stream to the **Maestro** output channel.

## Usage

Open VS Code Chat and:

```text
@maestro task Draft a migration plan from REST to GraphQL for our API
```

The Run Console opens automatically; agents stream into the tree and console as
they progress.

## Architecture

A thin adapter over the shared core. Surface-neutral, vscode-free modules
(`runtime-bridge.mjs`, `state/`, `views/` helpers, `adapters/`) are unit-tested
under `node --test`; only `extension.mjs` imports `vscode`. See the
[interface contracts](../extensions/ghcp-maestro/runtime/ports.mjs).
