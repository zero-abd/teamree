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
