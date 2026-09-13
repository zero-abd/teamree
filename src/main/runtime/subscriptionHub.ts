// Subscriptions are owned by the connection that created them, never by the
// thing being observed. A dropped socket or a reloaded renderer therefore tears
// down every stream it opened, which is the only way a long-lived runtime avoids
// leaking PTY listeners across days of use.

import type { StreamEvent } from '../../shared/protocol'
import { internal } from './runtimeError'

/** Where stream frames for one connection are written. */
export type FrameSink = (frame: StreamEvent) => void

/**
 * Told whenever one of a connection's subscriptions ends, whichever end ended
 * it: the client unsubscribed, the producer closed the stream, or the whole
 * connection went. A transport that has to keep a fact per subscription — which
 * pane a teammate is watching, say — otherwise has to guess at the two paths it
 * cannot see, and would keep a watcher on a pane that exited.
 */
export type SubscriptionEndSink = (subscriptionId: string) => void

export type SubscriptionChannel = {
  /** Push one event to the subscriber. Ignored once the subscription is gone. */
  emit: (event: unknown) => void
  /** End the subscription from the producer side, e.g. the PTY exited. */
  close: () => void
}

/** Starts producing events and returns the teardown for this subscription. */
export type SubscriptionSource = (channel: SubscriptionChannel) => () => void

type SubscriptionRecord = {
  active: boolean
  teardown: () => void
}

type ConnectionRecord = {
  sink: FrameSink
  onEnd: SubscriptionEndSink | undefined
  subscriptions: Map<string, SubscriptionRecord>
}

export class SubscriptionHub {
  private readonly connections = new Map<string, ConnectionRecord>()
  private counter = 0

  /** Registers a connection so its subscriptions have somewhere to write. */
  openConnection(connectionId: string, sink: FrameSink, onEnd?: SubscriptionEndSink): void {
    this.closeConnection(connectionId)
    this.connections.set(connectionId, { sink, onEnd, subscriptions: new Map() })
  }

  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    this.connections.delete(connectionId)
    for (const [id, record] of connection.subscriptions) {
      connection.subscriptions.delete(id)
      runTeardown(record)
      notifyEnd(connection, id)
    }
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId)
  }

  /**
   * Starts `source` and returns the subscription id the caller correlates
   * stream frames with. Throws if the connection is already gone.
   */
  subscribe(connectionId: string, source: SubscriptionSource): string {
    const connection = this.connections.get(connectionId)
    // `internal` on purpose, and chosen here rather than inherited from the
    // dispatcher's catch-all. Every connection id a handler can present was
    // minted by the transport when the socket or the window opened, so an id
    // this hub does not know is not a caller's mistake to correct — it is the
    // transport having failed to register, or having torn the connection down
    // while a subscribe was in flight. There is no client-side remedy to point
    // at, and no narrower code would describe it honestly.
    if (!connection) throw internal(`unknown connection: ${connectionId}`)

    this.counter += 1
    const subscriptionId = `sub_${this.counter}`
    const record: SubscriptionRecord = { active: true, teardown: () => {} }
    connection.subscriptions.set(subscriptionId, record)

    const channel: SubscriptionChannel = {
      emit: (event) => {
        if (!record.active) return
        connection.sink({ stream: subscriptionId, event })
      },
      close: () => {
        this.unsubscribe(connectionId, subscriptionId)
      }
    }

    try {
      record.teardown = source(channel)
    } catch (error) {
      record.active = false
      connection.subscriptions.delete(subscriptionId)
      throw error
    }

    // A source that closed itself synchronously still needs its teardown run.
    if (!record.active) record.teardown()
    return subscriptionId
  }

  /** Returns false when the id is unknown to this connection. */
  unsubscribe(connectionId: string, subscriptionId: string): boolean {
    const connection = this.connections.get(connectionId)
    const record = connection?.subscriptions.get(subscriptionId)
    if (!connection || !record) return false
    connection.subscriptions.delete(subscriptionId)
    runTeardown(record)
    notifyEnd(connection, subscriptionId)
    return true
  }

  countFor(connectionId: string): number {
    return this.connections.get(connectionId)?.subscriptions.size ?? 0
  }

  /** Total live subscriptions across every connection. Used by tests and diagnostics. */
  get size(): number {
    let total = 0
    for (const connection of this.connections.values()) total += connection.subscriptions.size
    return total
  }

  closeAll(): void {
    // Copied first: closeConnection mutates the map being iterated.
    for (const connectionId of [...this.connections.keys()]) this.closeConnection(connectionId)
  }
}

// A transport failing to keep its own books must not strand a teardown either.
function notifyEnd(connection: ConnectionRecord, subscriptionId: string): void {
  try {
    connection.onEnd?.(subscriptionId)
  } catch {
    // Nothing here can fix a sink that throws, and the subscription is gone.
  }
}

// Teardown failures must not strand the rest of a connection's subscriptions.
function runTeardown(record: SubscriptionRecord): void {
  if (!record.active) return
  record.active = false
  try {
    record.teardown()
  } catch {
    // Producer already gone; nothing useful to do here.
  }
}
