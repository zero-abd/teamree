// The handoff book's bounds and its file, and Hand Off's order: roster, then push, then the offer.
// Pushing runs the real git against throwaway repositories.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { MAX_HANDOFF_NOTE_CHARS, MAX_HANDOFFS } from '../../shared/presenceExtras'
import { ErrorCode } from '../../shared/protocol'
import type { MemoryNote } from '../../shared/memory'
import type { PeerHandoff } from '../../shared/tasks'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { pushWorktree } from '../git/worktreePush'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { TeamworkError } from './errors'
import {
  handoffDraft,
  HandoffBook,
  HANDOFFS_FILE,
  MAX_SETTLED_HANDOFFS,
  registerHandoffHandlers,
  type HandoffPorts
} from './handoffs'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const offer = (id: string, overrides: Partial<PeerHandoff & { projectId: string; worktreeId: string }> = {}) => ({
  id,
  to: 'bob',
  worktreeName: 'auth',
  branch: 'auth',
  note: '',
  at: 1,
  projectId: 'p',
  worktreeId: `wt_${id}`,
  ...overrides
})

describe('the handoff book', () => {
  it('clips the note and keeps at most the bound per project, dropping taken offers first', () => {
    const book = new HandoffBook()
    book.offer(offer('first', { note: 'x'.repeat(MAX_HANDOFF_NOTE_CHARS + 10) }))
    expect(book.outgoing('p')[0]?.note).toHaveLength(MAX_HANDOFF_NOTE_CHARS)

    book.markTaken(['p'], 'bob', ['first'], 5)
    for (let index = 0; index < MAX_HANDOFFS; index += 1) book.offer(offer(`h${index}`))
    const ids = book.outgoing('p').map((held) => held.id)
    expect(ids).toHaveLength(MAX_HANDOFFS)
    expect(ids).not.toContain('first')
    expect(ids).toContain('h0')
  })

  it('sends a teammate only their own untaken offers, without this machine’s ids', () => {
    const book = new HandoffBook()
    book.offer(offer('to-bob'))
    book.offer(offer('to-carol', { to: 'carol' }))
    book.offer(offer('elsewhere', { projectId: 'q' }))
    expect(book.sendTo(['p'], 'bob')).toEqual([
      { id: 'to-bob', to: 'bob', worktreeName: 'auth', branch: 'auth', note: '', at: 1 }
    ])
    expect(book.markTaken(['p'], 'carol', ['to-bob'], 2)).toBe(false)
    expect(book.markTaken(['p'], 'bob', ['to-bob'], 2)).toBe(true)
    expect(book.sendTo(['p'], 'bob')).toEqual([])
  })

  it('remembers a bounded number of answers, per sender', () => {
    const book = new HandoffBook()
    for (let index = 0; index <= MAX_SETTLED_HANDOFFS; index += 1) book.settle(`h${index}`, 'ana-key', 'took')
    expect(book.isSettled('h0', 'ana-key')).toBe(false)
    expect(book.isSettled(`h${MAX_SETTLED_HANDOFFS}`, 'ana-key')).toBe(true)
    expect(book.isSettled(`h${MAX_SETTLED_HANDOFFS}`, 'someone-else')).toBe(false)
    expect(book.tookFrom('ana-key')).toHaveLength(MAX_SETTLED_HANDOFFS)
  })

  it('reads back what it wrote, and starts empty from a damaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamree-handoffs-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const book = new HandoffBook(join(dir, HANDOFFS_FILE))
    book.offer(offer('kept'))
    book.settle('theirs', 'ana-key', 'dismissed')
    await book.flush()

    const again = new HandoffBook(join(dir, HANDOFFS_FILE))
    await again.load()
    expect(again.outgoing('p').map((held) => held.id)).toEqual(['kept'])
    expect(again.isSettled('theirs', 'ana-key')).toBe(true)

    await writeFile(join(dir, 'damaged.json'), '{"outgoing": [', 'utf8')
    const damaged = new HandoffBook(join(dir, 'damaged.json'))
    await damaged.load()
    expect(damaged.outgoing('p')).toEqual([])
  })
})

describe('Hand Off', () => {
  async function setUp(options: { withRemote: boolean; roster?: readonly string[] }) {
    const repo: TempRepo = await createTempRepo({ withRemote: options.withRemote })
    cleanups.push(() => repo.cleanup())
    await repo.git(['switch', '-c', 'rework-auth'])
    await repo.write('auth.ts', 'export {}\n')
    await repo.commit('Start the rework')
    const worktree: Worktree = {
      id: 'wt_auth',
      projectId: 'p',
      name: 'Rework auth session',
      branch: 'rework-auth',
      path: repo.repoPath,
      startedFrom: 'main',
      state: 'ready',
      createdAt: 0,
      task: 'Rework auth session'
    }
    const note = (text: string, over: Partial<MemoryNote> = {}): MemoryNote => ({
      id: text,
      worktreeId: 'wt_auth',
      kind: 'decision',
      text,
      scope: 'private',
      at: 1,
      author: 'me',
      ...over
    })
    const pushed: string[] = []
    const offered: string[] = []
    const roster = options.roster ?? ['bob']
    const ports: HandoffPorts = {
      peers: {
        handoffs: () => ({ incoming: [], outgoing: [] }),
        handoffTarget: (_projectId, to) => {
          if (!roster.includes(to)) throw new TeamworkError(ErrorCode.NotFound, `${to} is not on this project’s roster`)
          return to
        },
        offerHandoff: ({ to }) => {
          offered.push(to)
          return { id: 'h', to, worktreeName: worktree.name, branch: worktree.branch, note: '', at: 1 }
        },
        incomingHandoff: () => {
          throw new Error('not used')
        },
        settleHandoff: () => {}
      },
      worktree: (id) => (id === worktree.id ? worktree : undefined),
      project: () => undefined,
      push: async (worktreeId) => {
        pushed.push(worktreeId)
        return pushWorktree(repo.runner, { worktreeId, worktreePath: repo.repoPath, branch: worktree.branch })
      },
      runner: repo.runner,
      create: () => Promise.reject(new Error('not used')),
      settled: () => Promise.reject(new Error('not used')),
      startAgent: () => {},
      notes: () =>
        Promise.resolve([
          note('Sessions live in redis'),
          note('Someone else’s decision', { worktreeId: 'wt_other' }),
          note('Keep the old cookie?', { kind: 'question', open: true }),
          note('Answered already?', { kind: 'question', open: false })
        ]),
      commits: () => Promise.resolve(['Split the session store', 'Start the rework']),
      onError: () => {}
    }
    const registry = new MethodRegistry(
      createRuntimeContext({ version: 'test', store: {} as never, subscriptions: new SubscriptionHub() })
    )
    registerHandoffHandlers(registry, ports)
    const dispatch = createDispatcher(registry)
    const handOff = (to: string) =>
      dispatch(
        { id: '1', method: 'teamwork.handOff', params: { worktreeId: 'wt_auth', to, note: 'Finish it.' } },
        { connectionId: 'window' }
      )
    const draft = () =>
      dispatch({ id: '2', method: 'teamwork.handoffDraft', params: { worktreeId: 'wt_auth' } }, { connectionId: 'w' })
    return { repo, handOff, draft, pushed, offered }
  }

  it('drafts the note from the task, its own decisions and open questions, and the last commits', async () => {
    const { draft } = await setUp({ withRemote: false })
    expect(await draft()).toMatchObject({
      ok: true,
      result: {
        note:
          'Rework auth session\n\nDecided:\n- Sessions live in redis\n\nOpen:\n- Keep the old cookie?\n\n' +
          'Commits:\n- Split the session store\n- Start the rework'
      }
    })
    expect(handoffDraft({ task: undefined, decisions: [], questions: [], commits: ['x'.repeat(5_000)] })).toHaveLength(
      MAX_HANDOFF_NOTE_CHARS
    )
  })

  it('refuses with no remote, and offers nothing', async () => {
    const { handOff, offered } = await setUp({ withRemote: false })
    expect(await handOff('bob')).toMatchObject({ ok: false, error: { message: 'no remote' } })
    expect(offered).toEqual([])
  })

  it('refuses someone off the roster before anything is pushed', async () => {
    const { handOff, pushed, offered } = await setUp({ withRemote: true })
    expect(await handOff('mallory')).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
    expect(pushed).toEqual([])
    expect(offered).toEqual([])
  })

  it('publishes a branch that tracks nothing, then offers it', async () => {
    const { repo, handOff, offered } = await setUp({ withRemote: true })
    expect(await handOff('bob')).toMatchObject({ ok: true, result: { to: 'bob' } })
    expect(await repo.git(['rev-parse', '--abbrev-ref', 'rework-auth@{upstream}'])).toBe('origin/rework-auth')
    expect(offered).toEqual(['bob'])
  })
})
