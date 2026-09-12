// The renderer's only door to the runtime. UI code calls `call('worktree.list',
// {})` and gets the contract's result type back; there is no fetch, no socket,
// and no ipcRenderer anywhere in the renderer bundle.

import type { MethodName, ParamsOf, ResultOf, TerminalEvent, WorkspaceEvent } from '@shared/methods'
import type { ErrorCode, StreamEvent } from '@shared/protocol'

/** A structured error from the runtime. Branch on `code`, never on `message`. */
export class RuntimeCallError extends Error {
  readonly code: ErrorCode
  readonly data?: unknown

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RuntimeCallError'
    this.code = code
    this.data = data
  }
}

export async function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const response = await window.teamree.runtime.call(method, params)
  if (response.ok) return response.result as ResultOf<M>
  throw new RuntimeCallError(response.error.code, response.error.message, response.error.data)
}

/** Methods that open a stream, derived from the contract rather than listed. */
type SubscribingMethod = {
  [M in MethodName]: ResultOf<M> extends { subscription: string } ? M : never
}[MethodName]

export type Subscription = {
  readonly id: string
  /** Idempotent; safe to call from a React cleanup that may run twice. */
  close: () => Promise<void>
}

export async function subscribe<M extends SubscribingMethod>(
  method: M,
  params: ParamsOf<M>,
  onEvent: (event: unknown) => void
): Promise<Subscription> {
  installRouter()
  const { subscription } = (await call(method, params)) as { subscription: string }

  listeners.set(subscription, onEvent)
  // The runtime can emit before its response lands, so replay what arrived first.
  for (const event of takeOrphans(subscription)) onEvent(event)

  let closed = false
  return {
    id: subscription,
    close: async () => {
      if (closed) return
      closed = true
      listeners.delete(subscription)
      try {
        await call('unsubscribe', { subscription })
      } catch (error) {
        // A stream the runtime already tore down is not a failure to close.
        if (!(error instanceof RuntimeCallError) || error.code !== 'not_found') throw error
      }
    }
  }
}

/** Typed wrapper for one terminal's output stream. */
export function subscribeTerminal(terminalId: string, onEvent: (event: TerminalEvent) => void): Promise<Subscription> {
  return subscribe('terminal.subscribe', { terminalId }, (event) => onEvent(event as TerminalEvent))
}

/**
 * Typed wrapper for the workspace change stream: one invalidation per changed
 * collection, from whichever transport caused it. Prefer `watchWorkspace` in UI
 * code, which keeps a subscription alive across a runtime that is not answering
 * yet.
 */
export function subscribeWorkspace(onEvent: (event: WorkspaceEvent) => void): Promise<Subscription> {
  return subscribe('workspace.subscribe', {}, (event) => onEvent(event as WorkspaceEvent))
}

const listeners = new Map<string, (event: unknown) => void>()
const orphans = new Map<string, unknown[]>()
const MAX_ORPHAN_STREAMS = 32
const MAX_ORPHAN_EVENTS = 512

let routerInstalled = false

function installRouter(): void {
  if (routerInstalled) return
  routerInstalled = true

  window.teamree.runtime.onStream((frame: StreamEvent) => {
    const listener = listeners.get(frame.stream)
    if (listener) {
      listener(frame.event)
      return
    }
    bufferOrphan(frame)
  })

  // A reload would otherwise leave the runtime streaming into a dead page.
  window.addEventListener('pagehide', () => window.teamree.runtime.release())
}

function bufferOrphan(frame: StreamEvent): void {
  let buffered = orphans.get(frame.stream)
  if (!buffered) {
    // Bounded so a stream nobody ever claims cannot grow without limit.
    if (orphans.size >= MAX_ORPHAN_STREAMS) {
      const oldest = orphans.keys().next()
      if (!oldest.done) orphans.delete(oldest.value)
    }
    buffered = []
    orphans.set(frame.stream, buffered)
  }
  if (buffered.length < MAX_ORPHAN_EVENTS) buffered.push(frame.event)
}

function takeOrphans(subscriptionId: string): unknown[] {
  const buffered = orphans.get(subscriptionId) ?? []
  orphans.delete(subscriptionId)
  return buffered
}
