// The renderer's view of the runtime. The real transport lives in ../runtime and
// is owned elsewhere; the UI only ever depends on this narrow surface so that
// swapping the seeded stand-in for the real client is a single assignment.

import type { MethodName, ParamsOf, ResultOf, TerminalEvent, WorkspaceEvent } from '@shared/methods'

/** Connection lifecycle as the status bar needs to report it. */
export type ConnectionPhase = 'connecting' | 'ready' | 'retrying' | 'offline'

export type ConnectionState = {
  phase: ConnectionPhase
  /** Human-readable reason shown on hover when the phase is not `ready`. */
  detail?: string
}

/** Handle returned by a terminal subscription; idempotent to close. */
export type Subscription = { close(): void }

/** Handle for the workspace change stream; idempotent to close. */
export type WorkspaceWatch = { close(): void }

export interface RuntimeClient {
  /** Typed request/response against the method catalogue. */
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>

  /** Live output for one terminal. Resolves once the stream is established. */
  subscribeTerminal(terminalId: string, onEvent: (event: TerminalEvent) => void): Promise<Subscription>

  /**
   * Watches everything the workspace owns and keeps the stream up by itself, so
   * the UI never polls. Each event names a collection to re-read; returns
   * synchronously because a watch that is still connecting is still a watch.
   */
  watchWorkspace(onEvent: (event: WorkspaceEvent) => void): WorkspaceWatch

  readonly connection: ConnectionState

  /** Returns an unsubscribe function, so callers can wire it straight into effects. */
  onConnectionChange(listener: (state: ConnectionState) => void): () => void
}
