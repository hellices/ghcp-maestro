# Install surfaces

**English** | (English only — 한국어 요약은 [README.ko.md](../README.ko.md) 참조)

`/maestro` runs on two surfaces that **share one runtime core** (`core/*`, the
`@ghcp-maestro/core` package) but are **installed and distributed
separately**. The core is surface-agnostic; each surface is a thin adapter that
implements the ports in [`core/ports.mjs`](../core/ports.mjs)
(`RuntimePort` / `UiSinkPort` / `LogPort` / `CancellationPort`).

| Surface | Install | Run | UI |
| :-- | :-- | :-- | :-- |
| **GitHub Copilot CLI** | `copilot plugin install <repo>` | `copilot --experimental` | `/maestro` chat + `/maestros` text dashboard |
| **VS Code** | install the `ghcp-maestro` extension (`.vsix` or Marketplace) | open VS Code Chat | `@maestro` / `/maestro` chat + **Maestro** Activity Bar (Runs tree + interactive Run Console) |

Installing the CLI plugin does **not** install the VS Code extension (and vice
versa) — they are different distribution channels. Only the runtime core is
shared, so behavior and subcommands stay in lock-step.

## VS Code surface

The VS Code extension lives in [`vscode-extension/`](../vscode-extension/). It adds:

- a **chat participant** (`@maestro`) that mirrors the CLI subcommands
  (`task`, `brainstorm`, `run`, `workflows`),
- a **Runs** TreeView (run → phase → agent, with live status icons and a dense
  `model · tokens · tools · time` line per agent), and
- an interactive **Run Console** webview — a TUI-like, three-pane view
  (Phases / Agents / Infrastructure) that streams live updates, lets you drill
  into any agent's prompt, tool trace, and output, and retry a single agent — all
  **inside VS Code**, no external browser.

Because the VS Code extension host runs on its own Electron/Node runtime (not the
Copilot binary), point the extension at the Copilot CLI so it can spawn isolated
agent sessions:

```jsonc
// settings.json
{
  "maestro.copilotPath": "/absolute/path/to/copilot"
}
```

Leave it empty to fall back to the `COPILOT_CLI_PATH` environment variable. Run
logs stream to the **Maestro** output channel.
