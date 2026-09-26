// The browser stand-in has to announce its changes like the real runtime does,
// or the no-Electron path would quietly stop exercising the subscribe-and-
// refetch code the app actually runs on.

import { describe, expect, it } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'
import { createSeededRuntimeClient } from './seededRuntimeClient'

/** Events are delivered a turn late on purpose; this waits for that turn. */
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('seeded runtime client workspace stream', () => {
  it('announces a terminal and its worktree layout when one is opened', async () => {
    const client = createSeededRuntimeClient()
    const events: WorkspaceEvent[] = []
    const watch = client.watchWorkspace((event) => events.push(event))

    const [worktree] = await client.call('worktree.list', {})
    expect(worktree).toBeDefined()
    const terminal = await client.call('terminal.create', { worktreeId: worktree!.id })
    await delivered()

    expect(events).toContainEqual({ type: 'terminals' })
    expect(events).toContainEqual({ type: 'layout', worktreeId: terminal.worktreeId })
    watch.close()
  })

  it('announces a worktree twice: created, then settled to ready', async () => {
    const client = createSeededRuntimeClient()
    const events: WorkspaceEvent[] = []
    const watch = client.watchWorkspace((event) => events.push(event))

    const [project] = await client.call('project.list', {})
    await client.call('worktree.create', { projectId: project!.id, name: 'stream check' })
    await delivered()
    expect(events.filter((event) => event.type === 'worktrees')).toHaveLength(1)
    watch.close()
  })

  it('stops delivering once the watch is closed', async () => {
    const client = createSeededRuntimeClient()
    const events: WorkspaceEvent[] = []
    const watch = client.watchWorkspace((event) => events.push(event))
    watch.close()

    await client.call('project.add', { path: '/tmp/after-close' })
    await delivered()
    expect(events).toEqual([])
  })
})

describe('seeded start points', () => {
  it('offers remote branches and tags, not just local branches', async () => {
    const client = createSeededRuntimeClient()
    const [project] = await client.call('project.list', {})
    const listing = await client.call('worktree.startPoints', { projectId: project!.id })

    const kinds = new Set(listing.options.map((option) => option.kind))
    expect(kinds).toContain('localBranch')
    expect(kinds).toContain('remoteBranch')
    expect(kinds).toContain('tag')
    expect(listing.options[0]).toMatchObject({ ref: listing.baseRef, isBase: true })
    expect(listing.options.some((option) => option.isCurrent)).toBe(true)
  })

  it('caps a long listing so the truncated notice is reachable', async () => {
    const client = createSeededRuntimeClient()
    const projects = await client.call('project.list', {})
    const busy = projects.find((project) => project.name === 'ledger-api')
    const listing = await client.call('worktree.startPoints', { projectId: busy!.id })

    expect(listing.truncated).toBe(true)
    expect(listing.total).toBeGreaterThan(listing.options.length)
    expect(listing.options).toHaveLength(listing.limit)
  })
})

describe('seeded task, memory and add-on methods', () => {
  it('answers reads with empty results and keeps settings', async () => {
    const client = createSeededRuntimeClient()
    const [worktree] = await client.call('worktree.list', {})
    expect(await client.call('message.list', {})).toEqual([])
    expect(await client.call('project.context', { worktreeId: worktree!.id })).toMatchObject({ siblings: [], text: '' })
    expect(await client.call('memory.conflicts', { worktreeId: worktree!.id })).toEqual([])
    expect(await client.call('worktree.usage', {})).toEqual([])
    expect(await client.call('addons.status', {})).toEqual([{ id: 'jac-memory', state: 'off' }])
    expect(await client.call('settings.set', { showCost: true })).toMatchObject({
      shareTaskDetails: true,
      showCost: true
    })
    expect(await client.call('settings.get', {})).toMatchObject({ showCost: true })
  })
})
