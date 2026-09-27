// The handoff book's bounds and its file, and Hand Off's order: roster, stop, commit, push, then the offer.
// Committing and pushing run the real git against throwaway repositories.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { MAX_AGENT_ARGS_CHARS } from '../../shared/agentLaunch'
import { Params } from '../../shared/methods'
import { MAX_HANDOFF_BRIEF_CHARS, MAX_HANDOFF_NOTE_CHARS, MAX_HANDOFFS } from '../../shared/presenceExtras'
import { ErrorCode } from '../../shared/protocol'
import type { MemoryNote } from '../../shared/memory'
import type { PeerHandoff, WorktreeOverlap } from '../../shared/tasks'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { commitWorktree } from '../git/worktreeCommit'
import { pushWorktree } from '../git/worktreePush'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { TeamworkError } from './errors'
import {
  continuationPrompt,
  handoffBrief,
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
    const steps: string[] = []
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
      task: 'Rework auth session',
      report: { outcome: 'succeeded', summary: 'Sessions moved to redis.', paths: [], at: 1 }
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
    const offered: { to: string; note: string; brief?: string }[] = []
    const roster = options.roster ?? ['bob']
    const ports: HandoffPorts = {
      peers: {
        handoffs: () => ({ incoming: [], outgoing: [] }),
        handoffTarget: (_projectId, to) => {
          if (!roster.includes(to)) throw new TeamworkError(ErrorCode.NotFound, `${to} is not on this project’s roster`)
          return to
        },
        offerHandoff: ({ to, note, brief }) => {
          steps.push('offer')
          offered.push({ to, note, ...(brief === undefined ? {} : { brief }) })
          return { id: 'h', to, worktreeName: worktree.name, branch: worktree.branch, note, at: 1 }
        },
        incomingHandoff: () => {
          throw new Error('not used')
        },
        settleHandoff: () => {}
      },
      worktree: (id) => (id === worktree.id ? worktree : undefined),
      project: () => ({ id: 'p', name: 'p', path: repo.repoPath, baseRef: 'origin/main' }),
      push: async (worktreeId) => {
        steps.push('push')
        pushed.push(worktreeId)
        return pushWorktree(repo.runner, {
          worktreeId,
          worktreePath: repo.repoPath,
          branch: worktree.branch
        })
      },
      commit: (worktreeId, message) => {
        steps.push('commit')
        return commitWorktree(repo.runner, {
          worktreeId,
          worktreePath: repo.repoPath,
          message,
          all: true
        })
      },
      stopAgents: async () => {
        steps.push('stop')
        return 1
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
      createRuntimeContext({
        version: 'test',
        store: {} as never,
        subscriptions: new SubscriptionHub()
      })
    )
    registerHandoffHandlers(registry, ports)
    const dispatch = createDispatcher(registry)
    const handOff = (to: string, extra: { commit?: string; stopAgents?: boolean } = {}) =>
      dispatch(
        {
          id: '1',
          method: 'teamwork.handOff',
          params: { worktreeId: 'wt_auth', to, note: 'Finish it.', ...extra }
        },
        { connectionId: 'window' }
      )
    const draft = () =>
      dispatch({ id: '2', method: 'teamwork.handoffDraft', params: { worktreeId: 'wt_auth' } }, { connectionId: 'w' })
    const remoteFiles = () => repo.git(['ls-tree', '-r', '--name-only', 'origin/rework-auth'])
    return { repo, handOff, draft, pushed, offered, steps, remoteFiles }
  }

  it('drafts the note from the task and its own decisions; the rest travels in the brief', async () => {
    const { draft } = await setUp({ withRemote: false })
    expect(await draft()).toMatchObject({
      ok: true,
      result: { note: 'Rework auth session\n\nDecided:\n- Sessions live in redis' }
    })
    expect(handoffDraft({ task: 'x'.repeat(5_000), decisions: [] })).toHaveLength(MAX_HANDOFF_NOTE_CHARS)
  })

  it('commits the uncommitted work under the message, pushes it, and says what it carries', async () => {
    const { repo, handOff, offered, remoteFiles } = await setUp({ withRemote: true })
    await repo.write('index.md', '# half done\n')
    expect(await handOff('bob', { commit: 'WIP: Rework auth session' })).toMatchObject({
      ok: true
    })

    expect((await remoteFiles()).split('\n')).toContain('index.md')
    expect(await repo.git(['log', '-1', '--format=%s', 'origin/rework-auth'])).toBe('WIP: Rework auth session')
    expect(await repo.git(['status', '--porcelain'])).toBe('')
    const brief = offered[0]?.brief ?? ''
    expect(brief).toContain('Files changed (2):\n- auth.ts\n- index.md')
    expect(brief).toContain('Report (succeeded): Sessions moved to redis.')
    expect(brief).toContain('Open questions:\n- Keep the old cookie?')
    expect(brief).toContain('Commits since origin/main:\n- Split the session store')
  })

  it('leaves uncommitted work here when asked to, and pushes the commits alone', async () => {
    const { repo, handOff, remoteFiles } = await setUp({ withRemote: true })
    await repo.write('index.md', '# half done\n')
    expect(await handOff('bob')).toMatchObject({ ok: true })
    expect((await remoteFiles()).split('\n')).not.toContain('index.md')
    expect(await repo.git(['status', '--porcelain'])).toBe('?? index.md')
  })

  it('goes on when asked to commit a clean worktree', async () => {
    const { handOff, offered } = await setUp({ withRemote: true })
    expect(await handOff('bob', { commit: 'WIP: nothing' })).toMatchObject({ ok: true })
    expect(offered).toHaveLength(1)
  })

  it('stops the agent before the commit, so nothing lands after it', async () => {
    const { repo, handOff, steps } = await setUp({ withRemote: true })
    await repo.write('index.md', '# half done\n')
    await handOff('bob', { commit: 'WIP', stopAgents: true })
    expect(steps).toEqual(['stop', 'commit', 'push', 'offer'])
  })

  it('leaves the agent running unless asked', async () => {
    const { handOff, steps } = await setUp({ withRemote: true })
    await handOff('bob')
    expect(steps).toEqual(['push', 'offer'])
  })

  it('refuses with no remote, and offers nothing', async () => {
    const { handOff, offered } = await setUp({ withRemote: false })
    expect(await handOff('bob')).toMatchObject({ ok: false, error: { message: 'no remote' } })
    expect(offered).toEqual([])
  })

  it('refuses someone off the roster before anything is stopped, committed or pushed', async () => {
    const { handOff, pushed, offered, steps } = await setUp({ withRemote: true })
    expect(await handOff('mallory', { commit: 'WIP', stopAgents: true })).toMatchObject({
      ok: false,
      error: { code: ErrorCode.NotFound }
    })
    expect(pushed).toEqual([])
    expect(offered).toEqual([])
    expect(steps).toEqual([])
  })

  it('publishes a branch that tracks nothing, then offers it', async () => {
    const { repo, handOff, offered } = await setUp({ withRemote: true })
    expect(await handOff('bob')).toMatchObject({ ok: true, result: { to: 'bob' } })
    expect(await repo.git(['rev-parse', '--abbrev-ref', 'rework-auth@{upstream}'])).toBe('origin/rework-auth')
    expect(offered.map((held) => held.to)).toEqual(['bob'])
  })
})

describe('the brief and the receiver’s first prompt', () => {
  it('lists commits, files (bounded), the report and open questions, clipped to its bound', () => {
    const files = Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`)
    const brief = handoffBrief({
      task: 'Rework auth session\nwith every detail of the original prompt',
      base: 'origin/main',
      commits: ['WIP: Rework auth', 'Split the store'],
      files,
      report: { outcome: 'failed', summary: 'Tests for expiry are red.' },
      questions: ['Keep the old cookie?']
    })
    expect(brief).toBe(
      [
        'Task: Rework auth session',
        'Commits since origin/main:\n- WIP: Rework auth\n- Split the store',
        `Files changed (30):\n${files
          .slice(0, 20)
          .map((file) => `- ${file}`)
          .join('\n')}\n- +10 more`,
        'Report (failed): Tests for expiry are red.',
        'Open questions:\n- Keep the old cookie?'
      ].join('\n\n')
    )
    expect(
      handoffBrief({
        task: undefined,
        base: 'main',
        commits: ['x'.repeat(5_000)],
        files: [],
        questions: []
      })
    ).toHaveLength(MAX_HANDOFF_BRIEF_CHARS)
  })

  it('is the note and the brief under who handed it over, never the original task alone', () => {
    const prompt = continuationPrompt({
      from: 'alice',
      note: 'Just the tests left.',
      brief: 'Task: Rework auth'
    })
    expect(prompt).toBe(
      'alice handed this task over. Their work is committed on this branch; continue from it.\n\n' +
        'Note from alice:\nJust the tests left.\n\nTask: Rework auth'
    )
    expect(continuationPrompt({ note: '', brief: undefined })).toBe(
      'A teammate handed this task over. Their work is committed on this branch; continue from it.'
    )
    expect(continuationPrompt({ note: 'x'.repeat(4_096), brief: 'y'.repeat(2_048) })).toHaveLength(MAX_AGENT_ARGS_CHARS)
  })
})

describe('Take', () => {
  it('starts the agent on the continuation prompt and names the worktree’s task by the note', async () => {
    const started: { worktreeId: string; command: string; prompt: string | undefined }[] = []
    const created: unknown[] = []
    const incoming: PeerHandoff = {
      id: 'h',
      to: 'bob',
      from: 'alice',
      worktreeName: 'Rework auth session',
      branch: 'rework-auth',
      note: 'Just the tests left.',
      brief: 'Commits since origin/main:\n- WIP: Rework auth',
      at: 1
    }
    const ready: Worktree = {
      id: 'wt_new',
      projectId: 'p',
      name: 'Rework auth session',
      branch: 'rework-auth',
      path: '/w/new',
      startedFrom: 'origin/rework-auth',
      state: 'ready',
      createdAt: 0
    }
    const registry = new MethodRegistry(
      createRuntimeContext({
        version: 'test',
        store: {} as never,
        subscriptions: new SubscriptionHub()
      })
    )
    registerHandoffHandlers(registry, {
      ...inertPorts(),
      peers: { ...inertPorts().peers, incomingHandoff: () => incoming },
      project: () => ({ id: 'p', name: 'p', path: '/r', baseRef: 'origin/main' }),
      runner: {
        run: async () => ({ stdout: '', stderr: '' }),
        tryRun: async () => ({ stdout: '', stderr: '' }),
        binary: 'git'
      } as never,
      create: async (params) => {
        created.push(params)
        return ready
      },
      settled: async () => ready,
      startAgent: (worktreeId, command, prompt) => started.push({ worktreeId, command, prompt })
    })
    const dispatch = createDispatcher(registry)
    await dispatch(
      { id: '1', method: 'teamwork.take', params: { projectId: 'p', id: 'h', agent: 'claude' } },
      { connectionId: 'w' }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(created).toEqual([
      {
        projectId: 'p',
        name: 'Rework auth session',
        checkout: 'origin/rework-auth',
        task: 'Just the tests left.'
      }
    ])
    expect(started).toEqual([
      {
        worktreeId: 'wt_new',
        command: 'claude',
        prompt: continuationPrompt({ from: 'alice', note: incoming.note, brief: incoming.brief })
      }
    ])
  })
})

describe('overlaps after a handoff is taken', () => {
  it('leave out the copy handed away, and keep every other pair', async () => {
    const overlaps: WorktreeOverlap[] = [
      {
        worktreeId: 'wt_auth',
        with: { handle: 'bob', worktreeId: 'bob/wt_1' },
        paths: ['index.md'],
        conflicts: []
      },
      { worktreeId: 'wt_other', with: { worktreeId: 'wt_auth' }, paths: ['a.ts'], conflicts: [] },
      {
        worktreeId: 'wt_other',
        with: { handle: 'bob', worktreeId: 'bob/wt_2' },
        paths: ['b.ts'],
        conflicts: []
      }
    ]
    const registry = new MethodRegistry(
      createRuntimeContext({
        version: 'test',
        store: {} as never,
        subscriptions: new SubscriptionHub()
      })
    )
    registry.register('worktree.overlaps', Params.worktreeOverlaps, ({ projectId }) => ({
      projectId,
      overlaps,
      readAt: 1
    }))
    const outgoing = (takenAt?: number): PeerHandoff[] => [
      {
        id: 'h',
        to: 'bob',
        worktreeName: 'auth',
        branch: 'auth',
        note: '',
        at: 1,
        worktreeId: 'wt_auth',
        ...(takenAt === undefined ? {} : { takenAt })
      }
    ]
    let taken: number | undefined
    registerHandoffHandlers(registry, {
      ...inertPorts(),
      peers: {
        ...inertPorts().peers,
        handoffs: () => ({ incoming: [], outgoing: outgoing(taken) })
      }
    })
    const dispatch = createDispatcher(registry)
    const read = async () =>
      (
        (await dispatch(
          { id: '1', method: 'worktree.overlaps', params: { projectId: 'p' } },
          { connectionId: 'w' }
        )) as { result: { overlaps: WorktreeOverlap[] } }
      ).result.overlaps

    expect(await read()).toHaveLength(3)
    taken = 5
    expect(await read()).toEqual([overlaps[2]])
  })
})

function inertPorts(): HandoffPorts {
  const unused = () => Promise.reject(new Error('not used'))
  return {
    peers: {
      handoffs: () => ({ incoming: [], outgoing: [] }),
      handoffTarget: (_projectId, to) => to,
      offerHandoff: () => {
        throw new Error('not used')
      },
      incomingHandoff: () => {
        throw new Error('not used')
      },
      settleHandoff: () => {}
    },
    worktree: () => undefined,
    project: () => undefined,
    push: unused,
    commit: unused,
    stopAgents: unused,
    runner: {} as never,
    create: unused,
    settled: unused,
    startAgent: () => {},
    notes: () => Promise.resolve([]),
    commits: () => Promise.resolve([]),
    onError: () => {}
  }
}
