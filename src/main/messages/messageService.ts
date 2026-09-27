// `message.send|list|read`: routes a message, keeps it, records a `done` as the
// worktree's report, and hands what is queued to delivery.

import type { Terminal, Worktree } from '../../shared/entities'
import type { MessageParty, TaskMessage } from '../../shared/messages'
import type { ParamsOf } from '../../shared/methods'
import type { WorktreeReport } from '../../shared/tasks'
import { conflict, notFound } from '../runtime/runtimeError'
import { Delivery, type DeliveryOptions, type DeliveryPanes } from './delivery'
import { MessageStore } from './messageStore'
import { recipientsOf, senderOf, type Directory } from './routing'

export type MessageServiceOptions = {
  /** `<userData>/messages`. */
  dir: string
  worktrees: {
    list(): Worktree[]
    setReport(worktreeId: string, report: WorktreeReport): void
  }
  panes: DeliveryPanes & {
    all(): Terminal[]
    /** Each pane whose agent waits on an ask for you, with that ask's id. */
    asking?(byPane: ReadonlyMap<string, number>): void
  }
  /** What a worktree changed since its base, from git; the agent's word is not taken for it. */
  changedPaths: (worktreeId: string) => Promise<string[]>
  onChange: () => void
  /** An ask for the person at the window. */
  onAsk?: (message: TaskMessage) => void
  now?: () => number
  later?: DeliveryOptions['later']
}

export class MessageService {
  readonly store: MessageStore
  readonly delivery: Delivery

  constructor(private readonly options: MessageServiceOptions) {
    this.store = new MessageStore(options.dir, options.now)
    this.delivery = new Delivery({
      store: this.store,
      panes: options.panes,
      nameOf: (party) => this.nameOf(party),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.later === undefined ? {} : { later: options.later }),
      onDelivered: () => options.onChange()
    })
    // Whatever waited on an ask died with the last run.
    this.stopWaiting((ask) => ask.to.you === true)
  }

  async send(params: ParamsOf<'message.send'>): Promise<TaskMessage[]> {
    const directory: Directory = { worktrees: this.options.worktrees.list(), terminals: this.options.panes.all() }
    const from = senderOf(params.from, directory)
    const ask = params.kind === 'reply' ? this.openAsk(params.replyTo) : undefined
    const late = params.kind === 'note' && params.replyTo !== undefined ? this.lapsedAsk(params.replyTo) : undefined
    const answered = ask ?? late
    const recipients = answered !== undefined ? [answered.from] : recipientsOf(from, params.to, params.kind, directory)
    const projectOf = (party: MessageParty): string | undefined =>
      directory.worktrees.find((worktree) => worktree.id === party.worktreeId)?.projectId
    const projectId = projectOf(from) ?? ask?.projectId ?? recipients.map(projectOf).find((id) => id !== undefined)
    if (projectId === undefined) throw notFound('names no project')

    let paths: string[] | undefined
    if (params.kind === 'done') {
      const worktreeId = from.worktreeId
      if (worktreeId === undefined) throw conflict('done comes from a worktree')
      paths = await this.options.changedPaths(worktreeId).catch(() => [])
      // One done per turn: a later one replaces what was not yet delivered.
      for (const earlier of this.store.list({ worktreeId, kinds: ['done'], open: true })) {
        if (earlier.from.worktreeId === worktreeId) this.store.update(earlier.id, { state: 'read' })
      }
      this.options.worktrees.setReport(worktreeId, {
        outcome: params.outcome ?? 'succeeded',
        summary: params.text,
        paths,
        at: (this.options.now ?? Date.now)()
      })
    }
    if (answered !== undefined) this.store.update(answered.id, { state: 'answered', answeredBy: from })

    const sent = recipients.map((to) =>
      this.store.add({
        projectId,
        kind: params.kind,
        from,
        to,
        text: params.text,
        ...(params.options === undefined ? {} : { options: params.options }),
        ...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
        ...(params.kind === 'done' ? { outcome: params.outcome ?? 'succeeded', paths } : {})
      })
    )
    for (const message of sent) if (message.kind === 'ask' && message.to.you === true) this.options.onAsk?.(message)
    this.changed()
    this.delivery.pump()
    return sent
  }

  /** The asker stopped waiting on these asks, or started again. */
  waiting(ids: readonly number[], waiting: boolean): { changed: number } {
    let changed = 0
    for (const id of ids) {
      const ask = this.store.get(id)
      if (ask?.kind !== 'ask' || ask.state === 'answered' || (ask.expiredAt === undefined) === waiting) continue
      this.store.update(id, { expiredAt: waiting ? undefined : (this.options.now ?? Date.now)() })
      changed += 1
    }
    if (changed > 0) this.changed()
    return { changed }
  }

  /** Nothing in an exited pane still waits on its asks. */
  paneExited(terminalId: string): void {
    this.delivery.forget(terminalId)
    this.stopWaiting((ask) => ask.from.terminalId === terminalId)
  }

  list(params: ParamsOf<'message.list'>): TaskMessage[] {
    return this.store.list({ ...params, limit: params.limit ?? 200 })
  }

  /** Marks messages read; a queued one is then never pasted. */
  read(ids: readonly number[]): { read: number } {
    let read = 0
    for (const id of ids) {
      const message = this.store.get(id)
      if (message === undefined || (message.state !== 'queued' && message.state !== 'delivered')) continue
      // Read is how the window dismisses an ask for you, which it offers only once nothing waits on it.
      if (message.kind === 'ask' && message.to.you === true && message.expiredAt === undefined) continue
      this.store.update(id, { state: 'read' })
      read += 1
    }
    if (read > 0) this.changed()
    return { read }
  }

  nameOf(party: MessageParty): string {
    if (party.you === true) return 'you'
    const worktree = this.options.worktrees.list().find((entry) => entry.id === party.worktreeId)
    return worktree?.name ?? party.terminalId ?? party.worktreeId ?? 'unknown'
  }

  private openAsk(id: number | undefined): TaskMessage {
    const ask = this.unanswered(id)
    if (ask.expiredAt !== undefined) throw conflict(`#${ask.id}'s asker stopped waiting: send a note`)
    return ask
  }

  /** An ask nobody waits on any more, which a note may still answer. */
  private lapsedAsk(id: number): TaskMessage {
    const ask = this.unanswered(id)
    if (ask.expiredAt === undefined) throw conflict(`#${id}'s asker is still waiting: reply`)
    return ask
  }

  private unanswered(id: number | undefined): TaskMessage {
    const ask = id === undefined ? undefined : this.store.get(id)
    if (ask === undefined || ask.kind !== 'ask') throw notFound(`no ask #${id ?? ''}`)
    if (ask.state === 'answered') {
      throw conflict(`already answered by ${ask.answeredBy === undefined ? 'someone' : this.nameOf(ask.answeredBy)}`)
    }
    return ask
  }

  private stopWaiting(which: (ask: TaskMessage) => boolean): void {
    const asks = this.store
      .list({ kinds: ['ask'], open: true })
      .filter((ask) => ask.expiredAt === undefined && which(ask))
    if (asks.length > 0)
      this.waiting(
        asks.map((ask) => ask.id),
        false
      )
  }

  private changed(): void {
    const byPane = new Map<string, number>()
    for (const ask of this.store.list({ kinds: ['ask'], open: true })) {
      const pane = ask.from.terminalId
      if (ask.to.you === true && ask.expiredAt === undefined && pane !== undefined) byPane.set(pane, ask.id)
    }
    this.options.panes.asking?.(byPane)
    this.options.onChange()
  }
}
