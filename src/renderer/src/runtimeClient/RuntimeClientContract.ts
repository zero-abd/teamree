// The renderer's view of the runtime. The real transport lives in ../runtime and
// is owned elsewhere; the UI only ever depends on this narrow surface so that
// swapping the seeded stand-in for the real client is a single assignment.

import type { MethodName, ParamsOf, ResultOf, TerminalEvent } from '@shared/methods'

/** Connection lifecycle as the status bar needs to report it. */
export type ConnectionPhase = 'connecting' | 'ready' | 'retrying' | 'offline'

export type ConnectionState = {
  phase: ConnectionPhase
  /** Human-readable reason shown on hover when the phase is not `ready`. */
  detail?: string
}

/** Handle returned by a terminal subscription; idempotent to close. */
export type Subscription = { close(): void }

export interface RuntimeClient {
  /** Typed request/response against the method catalogue. */
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>

  /** Live output for one terminal. Resolves once the stream is established. */
  subscribeTerminal(terminalId: string, onEvent: (event: TerminalEvent) => void): Promise<Subscription>

  readonly connection: ConnectionState

  /** Returns an unsubscribe function, so callers can wire it straight into effects. */
  onConnectionChange(listener: (state: ConnectionState) => void): () => void
}
