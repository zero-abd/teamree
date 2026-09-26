// Clean Up Merged: one call takes the chosen worktrees, one notice says so, and its one Undo
// brings every one of them back, parents before their children.

import { beforeEach, expect, it, vi } from 'vitest'
import type { Project, Worktree, WorktreeCleanup } from '@shared/entities'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'main' }
const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name: id,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  ...extra
})
const parent = worktree('parent')
const child = worktree('child', { parentId: 'parent', baseRef: 'parent' })
const other = worktree('other')

const cleanup: WorktreeCleanup = {
  projectId: 'p1',
  dryRun: false,
  removed: [
    { worktree: child, trashId: 'child/1' },
    { worktree: parent, trashId: 'parent/1' }
  ],
  kept: []
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation((method: unknown, params: unknown) => {
    if (method === 'worktree.cleanMerged') return Promise.resolve(cleanup)
    if (method === 'worktree.restore') {
      const id = (params as { removedId: string }).removedId.split('/')[0]
      return Promise.resolve([parent, child].find((entry) => entry.id === id))
    }
    return new Promise(() => {})
  })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [parent, child, other],
      dialog: { kind: 'clean-up', projectId: 'p1' }
    },
    true
  )
})

it('takes the chosen worktrees in one call and says so in one notice with one Undo', async () => {
  await useWorkspaceStore.getState().confirmCleanUp('p1', ['parent', 'child'])

  expect(call).toHaveBeenCalledWith('worktree.cleanMerged', { projectId: 'p1', worktreeIds: ['parent', 'child'] })
  const after = useWorkspaceStore.getState()
  expect(after.dialog).toBeNull()
  expect(after.worktrees.map((entry) => entry.id)).toEqual(['other'])
  expect(after.notices).toHaveLength(1)
  expect(after.notices[0]).toMatchObject({
    text: 'Removed 2 worktrees',
    tone: 'info',
    action: { label: 'Undo', undo: { kind: 'remove-many', projectId: 'p1', removedIds: ['parent/1', 'child/1'] } }
  })
})

it('Undo restores every one, the parent before its child', async () => {
  await useWorkspaceStore.getState().confirmCleanUp('p1', ['parent', 'child'])
  const action = useWorkspaceStore.getState().notices[0]?.action
  if (action === undefined || !('undo' in action)) throw new Error('no undo')

  await useWorkspaceStore.getState().undo(action.undo)

  const restores = call.mock.calls.filter(([method]) => method === 'worktree.restore').map(([, params]) => params)
  expect(restores).toEqual([
    { projectId: 'p1', removedId: 'parent/1' },
    { projectId: 'p1', removedId: 'child/1' }
  ])
  expect(
    useWorkspaceStore
      .getState()
      .worktrees.map((entry) => entry.id)
      .sort()
  ).toEqual(['child', 'other', 'parent'])
  expect(useWorkspaceStore.getState().notices.filter((notice) => notice.tone === 'error')).toEqual([])
})

it('restores the rest when one cannot come back, and says how many did not', async () => {
  await useWorkspaceStore.getState().confirmCleanUp('p1', ['parent', 'child'])
  call.mockImplementation((method: unknown, params: unknown) =>
    method === 'worktree.restore' && (params as { removedId: string }).removedId === 'parent/1'
      ? Promise.reject(new Error('in use'))
      : Promise.resolve(child)
  )

  await useWorkspaceStore.getState().undo({ kind: 'remove-many', projectId: 'p1', removedIds: ['parent/1', 'child/1'] })

  expect(useWorkspaceStore.getState().worktrees.map((entry) => entry.id)).toContain('child')
  expect(useWorkspaceStore.getState().notices.at(-1)).toMatchObject({ tone: 'error' })
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('1 worktree')
})
