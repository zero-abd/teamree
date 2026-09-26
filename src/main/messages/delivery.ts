// Puts queued messages into agent prompts: a bracketed paste, then Return, the way a
// review comment is sent. Only into an agent pane that is stopped and nobody is typing in.

import type { Terminal } from '../../shared/entities'
import { activityOf } from '../../shared/paneActivity'
import type { TaskMessage } from '../../shared/messages'
import type { MessageStore } from './messageStore'
import { pastedText, type NameOf } from './messageText'
import { runsAgent } from './routing'

/** A pane a person typed into this recently is theirs; the message waits. */
export const TYPING_WINDOW_MS = 1500

/** Between the paste and its Return, so a prompt that times input bursts reads them as two. */
export const PASTE_SETTLE_MS = 60

/** After a paste, the pane gets the next one at its next Stop, or once this has passed. */
export const DELIVERY_GAP_MS = 3000

export type DeliveryPanes = {
  list(worktreeId: string): Terminal[]
  write(terminalId: string, data: string): void
}

export type DeliveryOptions = {
  store: MessageStore
  panes: DeliveryPanes
  nameOf: NameOf
  now?: () => number
  later?: (run: () => void, ms: number) => { cancel: () => void }
  onDelivered?: (message: TaskMessage) => void
}

export class Delivery {
  private readonly typedAt = new Map<string, number>()
  private readonly pastedAt = new Map<string, number>()
  private wake: { at: number; cancel: () => void } | undefined
  private pumping = false
  private again = false
  private readonly now: () => number
  private readonly later: NonNullable<DeliveryOptions['later']>

  constructor(private readonly options: DeliveryOptions) {
    this.now = options.now ?? Date.now
    this.later =
      options.later ??
      ((run, ms) => {
        const timer = setTimeout(run, ms)
        timer.unref?.()
        return { cancel: () => clearTimeout(timer) }
      })
  }

  /** A person's keystroke reached this pane. */
  noteTyped(terminalId: string): void {
    this.typedAt.set(terminalId, this.now())
  }

  forget(terminalId: string): void {
    this.typedAt.delete(terminalId)
    this.pastedAt.delete(terminalId)
  }

  /** Delivers what can be delivered now, and wakes itself for what is only held by time. */
  pump(): void {
    // A paste can raise the very event that pumps; that call waits for this one to finish.
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        this.pumpOnce()
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  private pumpOnce(): void {
    const now = this.now()
    let wakeAt = Number.POSITIVE_INFINITY
    const used = new Set<string>()
    for (const message of this.options.store.list({ open: true })) {
      const worktreeId = message.to.worktreeId
      if (message.state !== 'queued' || worktreeId === undefined) continue
      const panes = this.options.panes
        .list(worktreeId)
        .filter((pane) => message.to.terminalId === undefined || pane.id === message.to.terminalId)
        .filter((pane) => pane.running && pane.draining !== true && runsAgent(pane) && !used.has(pane.id))
      for (const pane of panes) {
        const held = this.heldUntil(pane, now)
        if (held === 0 && this.paste(pane.id, message)) {
          used.add(pane.id)
          break
        }
        if (held > 0) wakeAt = Math.min(wakeAt, held)
      }
    }
    this.scheduleWake(wakeAt)
  }

  /** 0 when the pane may take a paste now, the time it may otherwise, or Infinity when only an event can tell. */
  private heldUntil(pane: Terminal, now: number): number {
    if (activityOf(pane) !== 'quiet') return Number.POSITIVE_INFINITY
    const typed = this.typedAt.get(pane.id)
    if (typed !== undefined && now - typed < TYPING_WINDOW_MS) return typed + TYPING_WINDOW_MS
    const pasted = this.pastedAt.get(pane.id)
    if (pasted === undefined) return 0
    const stoppedSince = pane.agentEvent?.event === 'Stop' && pane.agentEvent.at > pasted
    if (stoppedSince || now - pasted >= DELIVERY_GAP_MS) return 0
    return pasted + DELIVERY_GAP_MS
  }

  private paste(terminalId: string, message: TaskMessage): boolean {
    try {
      this.options.panes.write(terminalId, `\x1b[200~${pastedText(message, this.options.nameOf)}\x1b[201~`)
    } catch {
      return false
    }
    this.later(() => {
      try {
        this.options.panes.write(terminalId, '\r')
      } catch {
        // Exited between the paste and its Return; the text went nowhere either.
      }
    }, PASTE_SETTLE_MS)
    this.pastedAt.set(terminalId, this.now())
    const delivered = this.options.store.update(message.id, { state: 'delivered' })
    if (delivered !== undefined) this.options.onDelivered?.(delivered)
    return true
  }

  private scheduleWake(at: number): void {
    if (this.wake !== undefined && this.wake.at <= at && this.wake.at > this.now()) return
    this.wake?.cancel()
    this.wake = undefined
    if (!Number.isFinite(at)) return
    const handle = this.later(
      () => {
        this.wake = undefined
        this.pump()
      },
      Math.max(0, at - this.now())
    )
    this.wake = { at, cancel: handle.cancel }
  }
}
