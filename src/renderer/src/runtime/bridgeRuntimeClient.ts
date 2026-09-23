// An object-shaped façade over the module-level client, which also tracks whether the runtime answers:
// the only connection state IPC can observe.

import type { MethodName, ParamsOf, ResultOf, TerminalEvent, WatchedPaneEvent, WorkspaceEvent } from '@shared/methods'
import { call, openStream, RuntimeCallError, subscribeTerminal, type Subscription } from './runtimeClient'
import { watchWorkspace, type WorkspaceWatch } from './workspaceStream'

export type ConnectionPhase = 'connecting' | 'ready' | 'retrying' | 'offline'

export type ConnectionState = {
  phase: ConnectionPhase
  /** Why the phase is not `ready`; shown on hover in the status bar. */
  detail?: string
}

/** A teammate's pane, opened for reading, with the owner's dimensions. */
export type WatchedPaneHandle = {
  subscription: Subscription
  cols: number
  rows: number
  handle: string
}

export type RuntimeClient = {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
  subscribeTerminal(terminalId: string, onEvent: (event: TerminalEvent) => void): Promise<Subscription>
  /** Live output for one of a teammate's panes. Read-only; there is no write. */
  watchPane(projectId: string, paneId: string, onEvent: (event: WatchedPaneEvent) => void): Promise<WatchedPaneHandle>
  /** Watches workspace changes and keeps the stream up; each event names a collection to refetch. */
  watchWorkspace(onEvent: (event: WorkspaceEvent) => void): WorkspaceWatch
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
        // A served error means the runtime is alive; only a transport failure means the link is gone.
        if (!(error instanceof RuntimeCallError)) setState({ phase: 'offline', detail: describe(error) })
        throw error
      }
    },
    subscribeTerminal,
    async watchPane(projectId, paneId, onEvent) {
      // Not the generic subscribe: the viewer needs the owner's size before it draws.
      const { subscription, result } = await openStream('teamwork.watch', { projectId, paneId }, (event) =>
        onEvent(event as WatchedPaneEvent)
      )
      return { subscription, cols: result.cols, rows: result.rows, handle: result.handle }
    },
    watchWorkspace: (onEvent) =>
      // A failed stream says as much about the connection as a failed call.
      watchWorkspace(onEvent, { onError: (error) => setState({ phase: 'offline', detail: describe(error) }) }),
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
