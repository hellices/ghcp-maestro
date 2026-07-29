// Child entry point for the compose dry run (#16).
//
// The candidate workflow module runs in this disposable `node` process so the
// parent can enforce a HARD timeout: a synchronous hang (`while (true) {}`)
// or a leaked timer inside the candidate cannot stall the host session — the
// parent simply SIGKILLs this process when the deadline elapses, and any side
// effects of module evaluation die with it.
//
// Usage: node compose-dry-run-child.mjs <candidate-file>
// Exit codes: 0 ok, 1 runtime failure (message on stderr), 2 bad module shape.
//
// This process is not connected to the host's JSON-RPC stdio — stderr is a
// pipe read by the parent, so writing to it here is safe.

import { pathToFileURL } from "node:url";
import { buildWorkflowApi } from "./saved-workflows.mjs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: compose-dry-run-child.mjs <candidate-file>\n");
  process.exit(2);
}

let run;
try {
  const mod = await import(pathToFileURL(file).href);
  run = typeof mod.default === "function" ? mod.default : mod.run;
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
}
if (typeof run !== "function") {
  process.stderr.write("module does not default-export a function\n");
  process.exit(2);
}

const echoAdapter = {
  name: "compose-dry-run-echo",
  async invoke(spec) {
    return { text: `echo:${spec.agent ?? spec.id ?? "agent"}` };
  },
};
// A stub run handle so runPhase/monitor plumbing works without touching the
// real run store; progress written during a dry run goes nowhere.
const stubRun = {
  runId: "compose-dry-run",
  readAgent: async () => undefined,
  writeAgent: async () => {},
  writeProgress: async () => {},
};
const api = buildWorkflowApi({
  session: { log: async () => {} },
  adapter: echoAdapter,
  run: stubRun,
  args: { input: "dry-run" },
  signal: new AbortController().signal,
  namespace: "compose-dry-run",
});

try {
  await run(api);
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
}
