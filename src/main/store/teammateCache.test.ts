// The cache is the whole of what makes a closed laptop a stale row rather than
// a missing one, and everything in it came off another machine. So these tests
// are about two things: that it survives a restart, and that nothing a peer
// sends can make it grow without limit or come back as something it is not.

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PeerWorktree } from '../../shared/entities'
import {
  MAX_CACHED_PANES,
  MAX_CACHED_PEERS,
  MAX_CACHED_TEXT,
  MAX_CACHED_WORKTREES,
  MAX_CACHE_AGE_MS,
  TeammateCacheStore,
  boundTeammate,
  parseTeammateCache,
  type CachedTeammate
} from './teammateCache'
import type { StoreProblem } from './workspaceStore'

const NOW = 1_700_000_000_000

async function cacheFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'teamree-cache-')), 'teammates.json')
}

function theirWorktree(overrides: Partial<PeerWorktree> = {}): PeerWorktree {
  return { id: 'wt_1', name: 'flaky test', branch: 'fix/flake', state: 'ready', panes: [], ...overrides }
}

function entry(overrides: Partial<CachedTeammate> = {}): CachedTeammate {
  return {
    publicKey: 'bobkey==',
    projectKey: 'abc123',
    handle: 'bob',
    heardAt: NOW,
    worktrees: [theirWorktree()],
    ...overrides
  }
}

describe('what a teammate last showed', () => {
  it('is still there after the app is closed and opened again', async () => {
    const filePath = await cacheFile()
    const first = await TeammateCacheStore.open(filePath, { now: () => NOW })
    first.put(entry())
    await first.flush()

    const second = await TeammateCacheStore.open(filePath, { now: () => NOW })
    expect(second.get('bobkey==', 'abc123')?.worktrees.map((worktree) => worktree.name)).toEqual(['flaky test'])
    expect(second.get('bobkey==', 'abc123')?.heardAt).toBe(NOW)
  })

  it('stops showing a worktree the teammate removed, because a snapshot replaces rather than adds to', async () => {
    const store = await TeammateCacheStore.open(await cacheFile(), { now: () => NOW })
    store.put(
      entry({ worktrees: [theirWorktree({ id: 'wt_1' }), theirWorktree({ id: 'wt_2', name: 'retry budget' })] })
    )
    // They deleted one and the next snapshot simply does not mention it. A
    // cache that merged would keep deleted work on screen forever.
    store.put(entry({ worktrees: [theirWorktree({ id: 'wt_2', name: 'retry budget' })] }))

    expect(store.get('bobkey==', 'abc123')?.worktrees.map((worktree) => worktree.id)).toEqual(['wt_2'])
  })

  it('keeps one teammate’s repositories apart, so a link never reads out another’s rows', async () => {
    const store = await TeammateCacheStore.open(await cacheFile(), { now: () => NOW })
    store.put(entry({ projectKey: 'abc123', worktrees: [theirWorktree({ name: 'here' })] }))
    store.put(entry({ projectKey: 'def456', worktrees: [theirWorktree({ name: 'elsewhere' })] }))

    expect(store.get('bobkey==', 'abc123')?.worktrees[0]?.name).toBe('here')
    expect(store.get('bobkey==', 'def456')?.worktrees[0]?.name).toBe('elsewhere')
  })
})

describe('the bounds on somebody else’s data', () => {
  it('refuses to hold more worktrees, panes or characters than a real workspace has', () => {
    const bounded = boundTeammate(
      entry({
        publicKey: 'k'.repeat(5_000),
        worktrees: Array.from({ length: MAX_CACHED_WORKTREES + 40 }, (_, index) =>
          theirWorktree({
            id: `wt_${index}`,
            name: 'n'.repeat(10_000),
            panes: Array.from({ length: MAX_CACHED_PANES + 10 }, (_, pane) => ({
              id: `t_${pane}`,
              title: 't'.repeat(10_000),
              shell: '/bin/zsh',
              running: true,
              busy: false,
              quietForMs: 0
            }))
          })
        )
      })
    )

    expect(bounded.worktrees).toHaveLength(MAX_CACHED_WORKTREES)
    expect(bounded.worktrees[0]?.panes).toHaveLength(MAX_CACHED_PANES)
    expect(bounded.worktrees[0]?.name.length).toBe(MAX_CACHED_TEXT)
    expect(bounded.worktrees[0]?.panes[0]?.title.length).toBe(MAX_CACHED_TEXT)
    expect(bounded.publicKey.length).toBe(MAX_CACHED_TEXT)
  })

  it('keeps the teammates most recently heard from when there are more than it holds', async () => {
    const store = await TeammateCacheStore.open(await cacheFile(), { now: () => NOW })
    for (let index = 0; index < MAX_CACHED_PEERS + 5; index += 1) {
      store.put(entry({ publicKey: `key_${index}`, heardAt: NOW - (MAX_CACHED_PEERS + 5 - index) * 1_000 }))
    }

    expect(store.list()).toHaveLength(MAX_CACHED_PEERS)
    expect(store.get('key_0', 'abc123')).toBeUndefined()
    expect(store.get(`key_${MAX_CACHED_PEERS + 4}`, 'abc123')).toBeDefined()
  })

  it('forgets a picture too old to be a picture of anything', async () => {
    const store = await TeammateCacheStore.open(await cacheFile(), { now: () => NOW })
    store.put(entry({ publicKey: 'ancient', heardAt: NOW - MAX_CACHE_AGE_MS - 1 }))
    store.put(entry({ publicKey: 'recent', heardAt: NOW }))

    expect(store.list().map((held) => held.publicKey)).toEqual(['recent'])
  })
})

describe('a file written by another build', () => {
  it('keeps every row it understands and drops only the ones it does not', () => {
    const document = parseTeammateCache({
      version: 99,
      teammates: [
        entry({ publicKey: 'good' }),
        // A shape from a version that filed worktrees differently.
        { publicKey: 'odd', projectKey: 'abc123', handle: 'odd', heardAt: NOW, worktrees: { wt_1: {} } },
        { publicKey: 'missing-fields' }
      ]
    })

    expect(document.teammates.map((held) => held.publicKey)).toEqual(['good'])
    expect(document.version).toBe(1)
  })

  it('keeps a teammate whose pane runs a harness this build has never heard of', () => {
    const pane = { title: 'zsh', shell: '/bin/zsh', running: true, busy: false, quietForMs: 0 }
    const panes = [
      { ...pane, id: 't_new', agent: 'harness-from-next-year' },
      { ...pane, id: 't_known', agent: 'codex' }
    ]
    const read = parseTeammateCache({
      version: 1,
      teammates: [{ ...entry(), worktrees: [{ ...theirWorktree(), panes }] }]
    })
    expect(read.teammates[0]?.worktrees[0]?.panes.map((one) => [one.id, one.agent])).toEqual([
      ['t_new', undefined],
      ['t_known', 'codex']
    ])
  })

  it('keeps the name a teammate gave a pane, and reads a file from before names crossed', () => {
    const pane = { title: 'zsh', shell: '/bin/zsh', running: true, busy: false, quietForMs: 0 }
    const panes = [
      { ...pane, id: 't_named', label: 'api server' },
      { ...pane, id: 't_older' },
      { ...pane, id: 't_long', label: 'l'.repeat(1_000) }
    ]
    const read = parseTeammateCache({
      version: 1,
      teammates: [{ ...entry(), worktrees: [{ ...theirWorktree(), panes }] }]
    })
    expect(read.teammates[0]?.worktrees[0]?.panes.map((one) => one.label?.slice(0, 10) ?? null)).toEqual([
      'api server',
      null,
      'llllllllll'
    ])
    expect(read.teammates[0]?.worktrees[0]?.panes[2]?.label?.length).toBe(MAX_CACHED_TEXT)
  })

  it('reads a document that is not one as an empty cache rather than as a failure', () => {
    expect(parseTeammateCache('nonsense').teammates).toEqual([])
    expect(parseTeammateCache(null).teammates).toEqual([])
    expect(parseTeammateCache({ teammates: 'not an array' }).teammates).toEqual([])
  })

  it('bounds what it reads as well as what it writes, whatever put the file there', () => {
    const document = parseTeammateCache({
      teammates: [entry({ worktrees: [theirWorktree({ name: 'n'.repeat(9_000) })] })]
    })
    expect(document.teammates[0]?.worktrees[0]?.name.length).toBe(MAX_CACHED_TEXT)
  })
})

describe('a file this process could not read', () => {
  it('is said out loud, and kept aside before anything is written over it', async () => {
    const filePath = await cacheFile()
    await writeFile(filePath, '{ this is not json', 'utf8')

    const problems: StoreProblem[] = []
    const store = await TeammateCacheStore.open(filePath, { now: () => NOW, onProblem: (p) => problems.push(p) })
    expect(problems.map((problem) => problem.kind)).toEqual(['unreadable'])
    expect(store.list()).toEqual([])

    store.put(entry())
    await store.flush()

    expect(problems.map((problem) => problem.kind)).toEqual(['unreadable', 'keptAside'])
    const kept = (await readdir(join(filePath, '..'))).filter((name) => name.includes('unreadable'))
    expect(kept).toHaveLength(1)
    expect(await readFile(join(filePath, '..', kept[0]!), 'utf8')).toBe('{ this is not json')
  })

  it('is not the same event as no file at all, which is how every first launch begins', async () => {
    const problems: StoreProblem[] = []
    const store = await TeammateCacheStore.open(await cacheFile(), { onProblem: (p) => problems.push(p) })
    expect(problems).toEqual([])
    expect(store.list()).toEqual([])
  })
})
