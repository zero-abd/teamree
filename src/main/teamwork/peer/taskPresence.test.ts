// Presence v2 between two runtimes on a fake relay: what bob reads of alice's task, its tree and its
// files, under the Share Task Details switch, and from a build that has never heard of any of it.

import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/entities'
import { MAX_PEER_PATHS, PEER_TASK_CHARS } from '../../../shared/presenceExtras'
import { loadIdentity } from '../identity'
import { parsePeerPresence, type PeerServiceOptions } from './peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  presenceOf,
  project,
  terminal,
  worktree
} from './peerTestSupport'
import { TASK_DETAILS_REFRESH_MS } from './presenceDetails'
import { PRESENCE_COALESCE_MS } from './peerService'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@github.com:team/repo.git'

async function pair(options: { share?: () => boolean; readTaskGit?: PeerServiceOptions['readTaskGit'] } = {}) {
  const relay = createFakeRelay()
  const scheduler = createManualScheduler()
  const aliceData = await makeProjectDir([])
  const bobData = await makeProjectDir([])
  const aliceKey = (await loadIdentity(aliceData)).publicKey
  const bobKey = (await loadIdentity(bobData)).publicKey
  const roster = [
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'bob', publicKey: bobKey }
  ]
  const shared = {
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN)
  }
  const parent: Worktree = {
    ...worktree('wt_parent', 'p_alice', 'rate limits', 'rate-limits'),
    task: 'Add rate limits'
  }
  const child: Worktree = {
    ...worktree('wt_child', 'p_alice', 'limiter', 'rate-limits-limiter'),
    task: 'Write the limiter\nToken bucket, per key.',
    parentId: 'wt_parent'
  }
  const alice = await createPeerRuntime({
    ...shared,
    dataDir: aliceData,
    ...(options.share ? { shareTaskDetails: options.share } : {}),
    ...(options.readTaskGit ? { readTaskGit: options.readTaskGit } : {}),
    workspace: {
      projects: [project('p_alice', await makeProjectDir(roster))],
      worktrees: [parent, child],
      terminals: [terminal('t_child', 'wt_child', { agent: 'claude', busy: true })]
    }
  })
  const bob = await createPeerRuntime({
    ...shared,
    dataDir: bobData,
    workspace: { projects: [project('p_bob', await makeProjectDir(roster))], worktrees: [], terminals: [] }
  })
  await alice.service.start()
  await bob.service.start()
  await scheduler.advance(0)
  // Git is read a beat after the first snapshot, and the snapshot that carries it is coalesced.
  const settle = async (): Promise<void> => scheduler.advance(TASK_DETAILS_REFRESH_MS + PRESENCE_COALESCE_MS * 2)
  await settle()
  const rows = () => presenceOf(bob.service, 'p_bob').worktrees
  return { alice, bob, rows, settle }
}

describe('teammates see the task', () => {
  it('carries alice’s task line, her tree and her changed paths to bob', async () => {
    const { rows } = await pair({
      readTaskGit: (target) =>
        Promise.resolve(target.id === 'wt_child' ? { paths: ['src/limiter.ts'], ahead: 1, clean: false } : undefined)
    })
    const byName = new Map(rows().map((row) => [row.name, row]))
    const parent = byName.get('rate limits')
    const child = byName.get('limiter')
    expect(parent?.task).toBe('Add rate limits')
    expect(child?.task).toBe('Write the limiter')
    expect(child?.parentId).toBe(parent?.id)
    expect(child?.paths).toEqual(['src/limiter.ts'])
    expect(child?.ahead).toBe(1)
    expect(child?.stage).toBe('working')
  })

  it('sends v1 only while alice has Share Task Details off, and v2 again once she turns it on', async () => {
    let sharing = false
    const { alice, rows, settle } = await pair({
      share: () => sharing,
      readTaskGit: () => Promise.resolve({ paths: ['src/limiter.ts'], ahead: 1, clean: false })
    })
    expect(rows().map((row) => Object.keys(row).filter((key) => key === 'task' || key === 'paths'))).toEqual([[], []])

    sharing = true
    alice.changed()
    await settle()
    expect(rows().every((row) => row.task !== undefined && row.paths !== undefined)).toBe(true)

    sharing = false
    alice.changed()
    await settle()
    expect(rows().some((row) => row.task !== undefined || row.paths !== undefined)).toBe(false)
  })
})

describe('a snapshot from another build', () => {
  const v1 = {
    revision: 1,
    handle: 'alice',
    projects: [
      {
        projectKey: 'k',
        worktrees: [{ id: 'w1', name: 'rate limits', branch: 'rate-limits', state: 'ready', panes: [] }]
      }
    ]
  }

  it('reads an old one unchanged', () => {
    expect(parsePeerPresence(v1, 'k')).toEqual(v1)
  })

  it('round-trips a new one, and bounds it', () => {
    const worktree = {
      ...v1.projects[0]!.worktrees[0]!,
      task: 't'.repeat(1_000),
      parentId: 'w0',
      paths: Array.from({ length: 10_000 }, (_, index) => `src/${index}.ts`),
      ahead: 3,
      stage: 'done',
      report: { outcome: 'succeeded', summary: 'Added limiter.' },
      memory: { revision: 1, notes: [] }
    }
    const read = parsePeerPresence({ ...v1, projects: [{ projectKey: 'k', worktrees: [worktree] }] }, 'k')
    const [kept] = read?.projects[0]?.worktrees ?? []
    expect(kept?.task).toHaveLength(PEER_TASK_CHARS)
    expect(kept?.paths).toHaveLength(MAX_PEER_PATHS)
    expect(kept).toMatchObject({ parentId: 'w0', ahead: 3, stage: 'done', report: worktree.report })
  })

  it('drops a malformed field alone, never the snapshot', () => {
    const worktree = { ...v1.projects[0]!.worktrees[0]!, stage: 'celebrating', ahead: -1, task: 'Add rate limits' }
    const [kept] =
      parsePeerPresence({ ...v1, projects: [{ projectKey: 'k', worktrees: [worktree] }] }, 'k')?.projects[0]
        ?.worktrees ?? []
    expect(kept?.task).toBe('Add rate limits')
    expect(kept?.stage).toBeUndefined()
    expect(kept?.ahead).toBeUndefined()
  })
})
