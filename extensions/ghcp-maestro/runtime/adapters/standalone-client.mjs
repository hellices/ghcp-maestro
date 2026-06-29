// Standalone CopilotClient adapter.
//
// Spawns an additional Copilot CLI subprocess via the public SDK
// (`new CopilotClient()`) and creates a fresh `CopilotSession` per
// `spawn()`. The resulting session is fully isolated from the host
// extension's session, so:
//   - Multiple specs really run in parallel (one child session per spec)
//   - The host's conversation history is not polluted
//   - Each agent uses a clean context window
//
// Cost: launching the standalone client spawns another Copilot CLI process
// per adapter instance. We start it lazily (on first invoke) and reuse it
// across invocations — only sessions are per-spec.

/**
 * @typedef {import("../spawn.mjs").SubagentAdapter} SubagentAdapter
 * @typedef {import("../spawn.mjs").AgentSpec} AgentSpec
 */

/**
 * @param {{
 *   defaultModel?: string,
 *   clientOptions?: object,
 *   logger?: { info?: (msg: string) => Promise<void> | void, warn?: (msg: string) => Promise<void> | void },
 * }} [deps]
 * @returns {SubagentAdapter & { stop: () => Promise<void> }}
 */
export function createStandaloneClientAdapter(deps = {}) {
  const { defaultModel, clientOptions = {}, logger } = deps;
  /** @type {Promise<{ client: any, approveAll: any }> | null} */
  let bootPromise = null;
  let stopped = false;

  async function boot() {
    if (stopped) throw new Error("standalone-client adapter already stopped");
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const sdk = await import("@github/copilot-sdk");
      // Resolve the bundled CLI entry from extension-injected env vars before
      // constructing the client. Without this, the SDK's default
      // `import.meta.resolve('@github/copilot-${plat}-${arch}/sdk')` fails
      // inside extension subprocesses because the platform package is not
      // visible from the extension's module graph.
      const opts = { ...clientOptions };
      if (!opts.connection) {
        const cliPath = resolveCliPath();
        if (cliPath) {
          opts.connection = sdk.RuntimeConnection.forStdio({ path: cliPath });
        }
      }
      const client = new sdk.CopilotClient(opts);
      if (typeof client.start === "function") {
        await client.start();
      }
      return { client, approveAll: sdk.approveAll };
    })();
    try {
      return await bootPromise;
    } catch (err) {
      bootPromise = null;
      throw err;
    }
  }

  return {
    name: "standalone-client",
    async invoke(spec, ctx) {
      if (ctx?.signal?.aborted) {
        throw ctx.signal.reason ?? new Error("aborted");
      }
      const t0 = Date.now();
      const { client, approveAll } = await boot();
      await logger?.info?.(
        `standalone-client: booted in ${Date.now() - t0}ms (cumulative)`,
      );

      const childSession = await client.createSession({
        onPermissionRequest: approveAll,
        model: spec.model ?? defaultModel,
      });

      try {
        if (ctx?.signal?.aborted) {
          throw ctx.signal.reason ?? new Error("aborted");
        }
        const reply = await childSession.sendAndWait(
          { prompt: spec.prompt },
          spec.timeoutMs ?? 60_000,
        );
        return {
          agent: spec.agent ?? null,
          sessionId: childSession.sessionId,
          text: extractText(reply),
        };
      } finally {
        try {
          await childSession.disconnect?.();
        } catch (err) {
          await logger?.warn?.(
            `standalone-client: childSession.disconnect failed: ${err?.message ?? err}`,
          );
        }
      }
    },
    async stop() {
      stopped = true;
      if (!bootPromise) return;
      try {
        const { client } = await bootPromise;
        await client.stop?.();
      } catch (err) {
        await logger?.warn?.(
          `standalone-client: client.stop failed: ${err?.message ?? err}`,
        );
      } finally {
        bootPromise = null;
      }
    },
  };
}

function extractText(assistantEvent) {
  if (!assistantEvent) return "";
  const data = assistantEvent.data ?? assistantEvent;
  if (typeof data?.content === "string") return data.content;
  if (Array.isArray(data?.content)) {
    return data.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  return "";
}

function resolveCliPath() {
  if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH;
  // When we run inside a Copilot CLI extension subprocess `process.execPath`
  // already points at the sea-loaded native Copilot binary
  // (e.g. ...\@github\copilot-win32-arm64\copilot.exe). Feed it back to the
  // SDK as the CLI executable: the SDK detects a non-".js" path and uses
  // `spawn(cliPath, args)` directly, so the binary receives the SDK's
  // `--headless --no-auto-update --stdio` flags as its own argv.
  const exec = process.execPath;
  if (exec && /copilot(?:\.exe)?$/i.test(exec)) return exec;
  const distDir = process.env.COPILOT_CLI_DIST_DIR;
  if (!distDir) return undefined;
  const sep = distDir.includes("/") && !distDir.includes("\\") ? "/" : "\\";
  return `${distDir}${sep}index.js`;
}
