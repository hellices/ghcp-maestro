// Core <-> surface contracts (interface-first boundary).
//
// These typedefs are the ONLY coupling between the shared runtime core and any
// surface (GHCP CLI extension, VS Code extension, future IDEs). The core never
// imports a surface; a surface composes the core and supplies implementations
// of these ports. Keeping the contracts in one place lets a new surface be
// added by implementing ports only — no reverse dependency, no shared mutable
// state across adapters.

/**
 * Normalised run lifecycle event the core emits toward any UI sink. Surfaces
 * project these into their own widgets (TreeView nodes, Webview rows, logs).
 *
 * @typedef {Object} RunUiEvent
 * @property {string} type - e.g. "run.started" | "phase.started" | "agent.started" | "agent.finished" | "run.finished"
 * @property {string} runId
 * @property {string} [phase]
 * @property {string} [agentId]
 * @property {unknown} [payload] - event-specific data (status, tokens, error, ...)
 */

/**
 * Input the core needs to start a `/maestro` subcommand, decoupled from how a
 * surface parsed it.
 *
 * @typedef {Object} MaestroCommandInput
 * @property {string} subcommand - "task" | "brainstorm" | "run" | "workflows" | ...
 * @property {string} args - raw tail args (JSON or free text), parsed by the workflow
 */

/**
 * Drives workflow runs. Implemented by each surface over the shared runtime.
 *
 * @typedef {Object} RuntimePort
 * @property {(input: MaestroCommandInput) => Promise<unknown>} runCommand
 * @property {(runId: string) => Promise<void>} resumeRun
 * @property {(runId: string) => Promise<void>} stopRun
 */

/**
 * Receives normalised run events. The VS Code surface feeds a run view-model;
 * the GHCP surface can ignore most events and rely on session.log.
 *
 * @typedef {Object} UiSinkPort
 * @property {(event: RunUiEvent) => void} onRunEvent
 */

/**
 * Surface-neutral logging. GHCP maps this to session.log(); VS Code maps it to
 * a chat response stream and/or the run timeline.
 *
 * @typedef {Object} LogPort
 * @property {(message: string) => Promise<void> | void} info
 * @property {(message: string) => Promise<void> | void} warn
 * @property {(message: string) => Promise<void> | void} error
 */

/**
 * Surface-neutral cancellation. GHCP has no token (no-op); VS Code binds a
 * CancellationToken.
 *
 * @typedef {Object} CancellationPort
 * @property {() => boolean} isCancelled
 * @property {(cb: () => void) => void} onCancel
 */

export {};
