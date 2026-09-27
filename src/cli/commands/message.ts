// `teamree msg`: an agent asks its parent, answers a child, reports done, or waits
// for its children. Local only; nothing here reaches a teammate.

import type { Worktree } from '../../shared/entities.js'
import {
  MESSAGE_KINDS,
  type MessageAddress,
  type MessageKind,
  type MessageParty,
  type TaskMessage
} from '../../shared/messages.js'
import { PANE_IDENTITY_ENV } from '../../shared/tasks.js'
import { readBoolean, readNumber, readString } from '../argv.js'
import type { CommandContext, CommandSpec } from '../command-spec.js'
import { CliError, ExitCode, UsageError } from '../exit.js'
import { HERE, selectHere, selectWorktree } from '../selectors.js'
import type { RuntimeClient } from '../transport.js'
import { WaitTimeout, waitForState } from '../waiting.js'

/** An ask waits this long before exiting with its id, to be resumed. */
export const DEFAULT_ASK_TIMEOUT_MS = 600_000
/** A person may be away from the window: an ask for you waits longer. */
export const DEFAULT_ASK_YOU_TIMEOUT_MS = 1_800_000
const DEFAULT_MSG_WAIT_TIMEOUT_MS = 600_000
/** Enough to find any message a project keeps. */
const LIST_LIMIT = 2000

type Me = { party: MessageParty; worktree?: Worktree; worktrees: Worktree[] }

async function whoAmI(context: CommandContext): Promise<Me> {
  const worktrees = await context.client.call('worktree.list', {})
  const terminalId = context.env[PANE_IDENTITY_ENV.terminalId] || undefined
  let worktree: Worktree | undefined
  try {
    worktree = selectHere(worktrees, { env: context.env, cwd: context.cwd })
  } catch {
    // Not in a pane or checkout: the person at a terminal of their own.
  }
  if (worktree === undefined) return { party: { you: true }, worktrees }
  return { party: { worktreeId: worktree.id, ...(terminalId ? { terminalId } : {}) }, worktree, worktrees }
}

function requireWorktree(me: Me): Worktree {
  if (me.worktree === undefined) {
    throw new CliError({
      code: 'not_found',
      message: 'No worktree here: not in a teamree pane or checkout.',
      exitCode: ExitCode.Failure
    })
  }
  return me.worktree
}

/** `parent`, `children`, `siblings`, `you`, a pane id, or a worktree. */
export function addressOf(token: string, me: Me, context: CommandContext): MessageAddress {
  if (token === 'parent' || token === 'children' || token === 'siblings') return { relation: token }
  if (token === 'you') return { you: true }
  if (token.startsWith('term_')) return { terminalId: token }
  return { worktreeId: selectWorktree(me.worktrees, token, { env: context.env, cwd: context.cwd }).id }
}

function body(context: CommandContext): string {
  const text = context.args.join(' ').trim()
  if (text === '') throw new UsageError('Say something: the message is empty.')
  return text
}

function nameOf(party: MessageParty, worktrees: readonly Worktree[]): string {
  if (party.you === true) return 'you'
  return worktrees.find((worktree) => worktree.id === party.worktreeId)?.name ?? party.terminalId ?? '?'
}

/** One message as `msg wait` and `msg ask` print it. */
export function messageLine(message: TaskMessage, worktrees: readonly Worktree[]): string {
  const from = nameOf(message.from, worktrees)
  switch (message.kind) {
    case 'ask': {
      const options = message.options === undefined ? '' : ` (${message.options.join(' | ')})`
      return `#${message.id} ask from "${from}": ${message.text}${options}`
    }
    case 'reply':
      return `#${message.id} reply to #${message.replyTo ?? '?'} from "${from}": ${message.text}`
    case 'done': {
      const files = message.paths === undefined ? '' : ` Files: ${message.paths.length}.`
      return `#${message.id} "${from}" done (${message.outcome ?? 'succeeded'}): ${message.text}${files}`
    }
    case 'note': {
      const answering = message.replyTo === undefined ? '' : `, answering #${message.replyTo}`
      return `#${message.id} note from "${from}"${answering}: ${message.text}`
    }
  }
}

async function findMessage(client: RuntimeClient, id: number, kind: MessageKind): Promise<TaskMessage> {
  const found = (await client.call('message.list', { kinds: [kind], limit: LIST_LIMIT })).find((m) => m.id === id)
  if (found === undefined) {
    throw new CliError({ code: 'not_found', message: `No ${kind} #${id}.`, exitCode: ExitCode.Failure })
  }
  return found
}

function positiveId(raw: string | number | undefined, what: string): number {
  const id = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`${what} is a message number, e.g. 7.`)
  return id
}

/** How long asks wait when `--timeout-ms` is not given. */
export function askTimeoutMs(asks: readonly TaskMessage[]): number {
  return asks.some((ask) => ask.to.you === true) ? DEFAULT_ASK_YOU_TIMEOUT_MS : DEFAULT_ASK_TIMEOUT_MS
}

/** Blocks until every ask has its reply; the replies are marked read so none is pasted too. */
async function awaitReplies(
  context: CommandContext,
  asks: readonly TaskMessage[],
  timeoutMs: number
): Promise<TaskMessage[]> {
  const ids = asks.map((ask) => ask.id)
  // The window shows an ask for you as waiting only while something here waits on it.
  const forYou = asks.filter((ask) => ask.to.you === true).map((ask) => ask.id)
  const stopWaiting = async (): Promise<void> => {
    if (forYou.length > 0) await context.client.call('message.waiting', { ids: forYou, waiting: false }).catch(() => {})
  }
  const release = stopOnSignal(stopWaiting)
  const read = async (): Promise<TaskMessage[]> => {
    const replies = await context.client.call('message.list', { kinds: ['reply'], limit: LIST_LIMIT })
    return ids.flatMap((id) => replies.filter((reply) => reply.replyTo === id).slice(0, 1))
  }
  let replies: TaskMessage[]
  try {
    replies = await waitForState({
      client: context.client,
      what: `an answer to #${ids.join(', #')}`,
      read,
      settled: (found) => found.length === ids.length,
      timeoutMs
    })
  } catch (error) {
    await stopWaiting()
    if (!(error instanceof WaitTimeout)) throw error
    throw new CliError({
      code: 'wait_timeout',
      message: `No answer to #${ids.join(', #')} after ${timeoutMs}ms.`,
      hint: ids.map((id) => `teamree msg ask --resume ${id}`).join('\n'),
      exitCode: ExitCode.Failure,
      data: { ids }
    })
  } finally {
    release()
  }
  const unread = replies.filter((reply) => reply.state === 'queued' || reply.state === 'delivered')
  if (unread.length > 0) await context.client.call('message.read', { ids: unread.map((reply) => reply.id) })
  return replies
}

/** Killed mid-wait, as an agent's tool timeout does, the ask is still let go before exiting. */
function stopOnSignal(stop: () => Promise<void>): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.once(signal, onSignal)
  return () => {
    for (const signal of signals) process.off(signal, onSignal)
  }
}

const TO_FLAG = {
  name: 'to',
  kind: 'string',
  placeholder: '<who>',
  description: 'parent (the default), children, siblings, you, a pane id, or a worktree.'
} as const

const TIMEOUT_FLAG = {
  name: 'timeout-ms',
  kind: 'number',
  placeholder: '<ms>',
  description: 'How long to wait; default 600000.'
} as const

const ASK_TIMEOUT_FLAG = {
  ...TIMEOUT_FLAG,
  description: 'How long to wait; default 600000, or 1800000 for you.'
} as const

export const messageCommands: readonly CommandSpec[] = [
  {
    path: ['msg', 'ask'],
    summary: 'Ask the parent task (or --to) and wait for the answer.',
    details:
      'An idle agent gets the question pasted into its prompt; a busy one at its next stop; you see it on the row. ' +
      'On timeout it exits 1 and prints the id: resume with --resume, which never asks twice.',
    args: [{ name: 'question', description: 'The question.', required: false, variadic: true }],
    flags: [
      TO_FLAG,
      { name: 'options', kind: 'string', placeholder: '<a,b>', description: 'Answers to offer, comma-separated.' },
      ASK_TIMEOUT_FLAG,
      { name: 'resume', kind: 'number', placeholder: '<id>', description: 'Keep waiting on an earlier ask.' }
    ],
    examples: ['teamree msg ask "Which store for the limiter?" --options redis,postgres', 'teamree msg ask --resume 7'],
    run: async (context) => {
      const me = await whoAmI(context)
      const resume = readNumber(context.flags, 'resume')
      let asks: TaskMessage[]
      if (resume !== undefined) {
        const ask = await findMessage(context.client, positiveId(resume, '--resume'), 'ask')
        if (ask.to.you === true) await context.client.call('message.waiting', { ids: [ask.id], waiting: true })
        asks = [ask]
      } else {
        requireWorktree(me)
        const options = readString(context.flags, 'options')
          ?.split(',')
          .map((option) => option.trim())
          .filter((option) => option !== '')
        asks = await context.client.call('message.send', {
          from: me.party,
          to: addressOf(readString(context.flags, 'to') ?? 'parent', me, context),
          kind: 'ask',
          text: body(context),
          ...(options === undefined || options.length === 0 ? {} : { options })
        })
      }
      const timeoutMs = readNumber(context.flags, 'timeout-ms') ?? askTimeoutMs(asks)
      const replies = await awaitReplies(context, asks, timeoutMs)
      const text =
        replies.length === 1
          ? (replies[0]?.text ?? '')
          : replies.map((reply) => `${nameOf(reply.from, me.worktrees)}: ${reply.text}`).join('\n')
      return { data: { asks, replies }, text }
    }
  },
  {
    path: ['msg', 'reply'],
    summary: 'Answer an ask by its number.',
    args: [
      { name: 'id', description: 'The ask, e.g. 7.', required: true },
      { name: 'answer', description: 'The answer.', required: true, variadic: true }
    ],
    examples: ['teamree msg reply 7 postgres'],
    run: async (context) => {
      const [raw, ...words] = context.args
      const ask = await findMessage(context.client, positiveId(raw, 'The id'), 'ask')
      const me = await whoAmI(context)
      const [reply] = await context.client.call('message.send', {
        from: me.party,
        to: ask.from,
        kind: 'reply',
        replyTo: ask.id,
        text: body({ ...context, args: words })
      })
      return { data: reply, text: `answered #${ask.id}` }
    }
  },
  {
    path: ['msg', 'done'],
    summary: 'Report this task finished: the parent is told, the row shows the summary.',
    details: 'teamree attaches the changed paths from git. A later done replaces an earlier one.',
    args: [{ name: 'summary', description: 'Up to three sentences.', required: true, variadic: true }],
    flags: [{ name: 'failed', kind: 'boolean', description: 'The task did not succeed.' }],
    examples: ['teamree msg done "Added the limiter. Tests pass. Nothing left."', 'teamree msg done --failed "…"'],
    run: async (context) => {
      const me = await whoAmI(context)
      requireWorktree(me)
      const [done] = await context.client.call('message.send', {
        from: me.party,
        to: { relation: 'parent' },
        kind: 'done',
        text: body(context),
        outcome: readBoolean(context.flags, 'failed') ? 'failed' : 'succeeded'
      })
      return { data: done, text: `done: told ${done === undefined ? 'nobody' : nameOf(done.to, me.worktrees)}` }
    }
  },
  {
    path: ['msg', 'note'],
    summary: 'Tell the parent (or --to) something; nobody waits for an answer.',
    args: [{ name: 'text', description: 'The note.', required: true, variadic: true }],
    flags: [TO_FLAG],
    examples: ['teamree msg note "Schema changed: see migrations/0042" --to siblings'],
    run: async (context) => {
      const me = await whoAmI(context)
      const sent = await context.client.call('message.send', {
        from: me.party,
        to: addressOf(readString(context.flags, 'to') ?? 'parent', me, context),
        kind: 'note',
        text: body(context)
      })
      return { data: sent, text: `told ${sent.map((note) => nameOf(note.to, me.worktrees)).join(', ')}` }
    }
  },
  {
    path: ['msg', 'inbox'],
    summary: 'List what waits for this worktree, or for you outside one; each is returned once.',
    examples: ['teamree msg inbox', 'teamree msg inbox --json'],
    run: async (context) => {
      const me = await whoAmI(context)
      const mine = (party: MessageParty): boolean =>
        me.worktree === undefined ? party.you === true : party.worktreeId === me.worktree.id
      const messages = (await context.client.call('message.list', { open: true, limit: LIST_LIMIT })).filter(
        (message) => mine(message.to) && (message.state === 'queued' || message.kind === 'ask')
      )
      const unread = messages.filter((message) => message.state === 'queued' && message.kind !== 'ask')
      if (unread.length > 0) await context.client.call('message.read', { ids: unread.map((message) => message.id) })
      return {
        data: messages,
        text:
          messages.length === 0 ? 'Nothing.' : messages.map((message) => messageLine(message, me.worktrees)).join('\n')
      }
    }
  },
  {
    path: ['msg', 'wait'],
    summary: 'Wait for messages to this worktree, as a supervisor; each is returned once.',
    flags: [
      {
        name: 'kind',
        kind: 'string',
        placeholder: '<kinds>',
        description: `Comma-separated: ${MESSAGE_KINDS.join(', ')}. Default all.`
      },
      {
        name: 'from',
        kind: 'string',
        placeholder: '<who>',
        description: 'children, parent, siblings, you, or a worktree. Default anyone.'
      },
      TIMEOUT_FLAG
    ],
    examples: ['teamree msg wait --kind done,ask --from children'],
    run: async (context) => {
      const me = await whoAmI(context)
      const self = requireWorktree(me)
      const kinds = kindsOf(readString(context.flags, 'kind'))
      const from = senderTest(readString(context.flags, 'from'), self, me, context)
      const read = async (): Promise<TaskMessage[]> =>
        (await context.client.call('message.list', { worktreeId: self.id, kinds, limit: LIST_LIMIT })).filter(
          (message) => message.to.worktreeId === self.id && message.state === 'queued' && from(message.from)
        )
      const messages = await waitForState({
        client: context.client,
        what: 'a message',
        read,
        settled: (found) => found.length > 0,
        timeoutMs: readNumber(context.flags, 'timeout-ms') ?? DEFAULT_MSG_WAIT_TIMEOUT_MS
      })
      await context.client.call('message.read', { ids: messages.map((message) => message.id) })
      const worktrees = await context.client.call('worktree.list', {})
      return { data: messages, text: messages.map((message) => messageLine(message, worktrees)).join('\n') }
    }
  }
]

function kindsOf(raw: string | undefined): MessageKind[] {
  if (raw === undefined) return [...MESSAGE_KINDS]
  const kinds = raw.split(',').map((kind) => kind.trim())
  const unknown = kinds.filter((kind) => !(MESSAGE_KINDS as readonly string[]).includes(kind))
  if (unknown.length > 0) throw new UsageError(`Unknown kind ${unknown.join(', ')}; use ${MESSAGE_KINDS.join(', ')}.`)
  return kinds as MessageKind[]
}

function senderTest(
  raw: string | undefined,
  self: Worktree,
  me: Me,
  context: CommandContext
): (party: MessageParty) => boolean {
  if (raw === undefined) return () => true
  if (raw === 'you') return (party) => party.you === true
  const ids = new Set(
    raw === 'children'
      ? me.worktrees.filter((worktree) => worktree.parentId === self.id).map((worktree) => worktree.id)
      : raw === 'parent'
        ? [self.parentId ?? '']
        : raw === 'siblings'
          ? me.worktrees
              .filter((w) => w.id !== self.id && w.projectId === self.projectId && w.parentId === self.parentId)
              .map((worktree) => worktree.id)
          : [selectWorktree(me.worktrees, raw === HERE ? self.id : raw, { env: context.env, cwd: context.cwd }).id]
  )
  return (party) => party.worktreeId !== undefined && ids.has(party.worktreeId)
}
