// An object-shaped façade over the module-level client, for UI code that wants
// one injectable dependency instead of imported functions. It also tracks
// whether the runtime is answering at all, which is the only connection state a
// renderer speaking over IPC can actually observe.

import type { MethodName, ParamsOf, ResultOf, TerminalEvent } from '@shared/methods'
import { call, RuntimeCallError, subscribeTerminal, type Subscription } from './runtimeClient'

export type ConnectionPhase = 'connecting' | 'ready' | 'retrying' | 'offline'

export type ConnectionState = {
  phase: ConnectionPhase
  /** Why the phase is not `ready`; shown on hover in the status bar. */
  detail?: string
}

export type RuntimeClient = {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
  subscribeTerminal(terminalId: string, onEvent: (event: TerminalEvent) => void): Promise<Subscription>
  readonly connection: ConnectionState
  onConnectionChange(listener: (state: ConnectionState) => void): () => void
  /** Re-probes the runtime, e.g. from a "retry" affordance. */
  refresh(): Promise<void>
}

export function createRuntimeClient(): RuntimeClient {
  let state: ConnectionState = { phase: 'connecting' }
  const listeners = new Set<(next: ConnectionState) => void>()

  const setState = (next: ConnectionState): void => {
    if (next.phase === state.phase && next.detail === state.detail) return
    state = next
    // Copied first: a listener may unregister itself while being notified.
    for (const listener of [...listeners]) listener(state)
  }

  const probe = async (): Promise<void> => {
    if (state.phase !== 'connecting') setState({ phase: 'retrying' })
    try {
      await call('status.get', {})
      setState({ phase: 'ready' })
    } catch (error) {
      setState({ phase: 'offline', detail: describe(error) })
    }
  }

  void probe()

  return {
    async call(method, params) {
      try {
        const result = await call(method, params)
        if (state.phase !== 'ready') setState({ phase: 'ready' })
        return result
      } catch (error) {
        // A served error means the runtime is alive and disagreeing; only a
        // transport failure says the connection itself is gone.
        if (!(error instanceof RuntimeCallError)) setState({ phase: 'offline', detail: describe(error) })
        throw error
      }
    },
    subscribeTerminal,
    get connection() {
      return state
    },
    onConnectionChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: probe
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
