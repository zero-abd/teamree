// Subscriptions are owned by the connection that created them, never by the
// thing being observed. A dropped socket or a reloaded renderer therefore tears
// down every stream it opened, which is the only way a long-lived runtime avoids
// leaking PTY listeners across days of use.

import type { StreamEvent } from '../../shared/protocol'

/** Where stream frames for one connection are written. */
export type FrameSink = (frame: StreamEvent) => void

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
  subscriptions: Map<string, SubscriptionRecord>
}

export class SubscriptionHub {
  private readonly connections = new Map<string, ConnectionRecord>()
  private counter = 0

  /** Registers a connection so its subscriptions have somewhere to write. */
  openConnection(connectionId: string, sink: FrameSink): void {
    this.closeConnection(connectionId)
    this.connections.set(connectionId, { sink, subscriptions: new Map() })
  }

  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    this.connections.delete(connectionId)
    for (const [id, record] of connection.subscriptions) {
      connection.subscriptions.delete(id)
      runTeardown(record)
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
    if (!connection) throw new Error(`unknown connection: ${connectionId}`)

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
