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
  panes: DeliveryPanes & { all(): Terminal[] }
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
  }

  async send(params: ParamsOf<'message.send'>): Promise<TaskMessage[]> {
    const directory: Directory = { worktrees: this.options.worktrees.list(), terminals: this.options.panes.all() }
    const from = senderOf(params.from, directory)
    const ask = params.kind === 'reply' ? this.openAsk(params.replyTo) : undefined
    const recipients = ask !== undefined ? [ask.from] : recipientsOf(from, params.to, params.kind, directory)
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
    if (ask !== undefined) this.store.update(ask.id, { state: 'answered', answeredBy: from })

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
    this.options.onChange()
    this.delivery.pump()
    return sent
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
      this.store.update(id, { state: 'read' })
      read += 1
    }
    if (read > 0) this.options.onChange()
    return { read }
  }

  nameOf(party: MessageParty): string {
    if (party.you === true) return 'you'
    const worktree = this.options.worktrees.list().find((entry) => entry.id === party.worktreeId)
    return worktree?.name ?? party.terminalId ?? party.worktreeId ?? 'unknown'
  }

  private openAsk(id: number | undefined): TaskMessage {
    const ask = id === undefined ? undefined : this.store.get(id)
    if (ask === undefined || ask.kind !== 'ask') throw notFound(`no ask #${id ?? ''}`)
    if (ask.state === 'answered') {
      throw conflict(`already answered by ${ask.answeredBy === undefined ? 'someone' : this.nameOf(ask.answeredBy)}`)
    }
    return ask
  }
}
