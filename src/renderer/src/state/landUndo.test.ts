// A local landing's notice: Merged <task> into main with an Undo that puts main back, and none once main moved or was pushed.

import { beforeEach, expect, it, vi } from 'vitest'
import type { Project, ProjectBase, Worktree, WorktreeMerge } from '@shared/entities'

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
const { liveAction } = await import('../notices/noticeView')

const INITIAL = useWorkspaceStore.getState()
const HEAD = 'a'.repeat(40)
const BEFORE = 'b'.repeat(40)

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }
const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name: 'fix cart rounding',
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  ...extra
})
const merge = (extra: Partial<WorktreeMerge> = {}): WorktreeMerge => ({
  worktreeId: 'w1',
  into: 'main',
  checkout: '/repos/pager',
  commits: [{ shortSha: 'abc1234', subject: 'Fix cart' }],
  fastForward: false,
  dirty: [],
  merged: true,
  head: HEAD,
  before: BEFORE,
  ...extra
})
const base = (extra: Partial<ProjectBase> = {}): ProjectBase => ({
  projectId: 'p1',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  head: HEAD,
  ...extra
})

let merged = merge()

beforeEach(() => {
  merged = merge()
  call.mockReset()
  call.mockImplementation((method: unknown) => {
    if (method === 'worktree.mergeIntoBase') return Promise.resolve(merged)
    if (method === 'project.resetBase') return Promise.resolve(base({ ahead: 0, head: BEFORE }))
    return new Promise(() => {})
  })
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [project], worktrees: [worktree('w1'), worktree('c1', { parentId: 'w1' })] },
    true
  )
})

const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

it('says a local landing merged, with an Undo that puts main back where it was', async () => {
  expect(await store().mergeIntoBase('w1')).toBeNull()

  const [notice] = store().notices
  expect(notice).toMatchObject({
    text: 'Merged "fix cart rounding" into main',
    tone: 'info',
    action: { label: 'Undo', undo: { kind: 'land', projectId: 'p1', head: HEAD, before: BEFORE } }
  })
  if (notice?.action === undefined || !('undo' in notice.action)) throw new Error('no undo')
  await store().undo(notice.action.undo)

  expect(call).toHaveBeenCalledWith('project.resetBase', { projectId: 'p1', landing: { head: HEAD, before: BEFORE } })
  expect(store().bases.p1).toMatchObject({ head: BEFORE })
})

it('offers no Undo for a landing that pushed, and says nothing for a child landing in its parent', async () => {
  merged = merge({ pushed: true })
  await store().mergeIntoBase('w1', true)
  expect(store().notices).toEqual([expect.objectContaining({ text: 'Merged "fix cart rounding" into main' })])
  expect(store().notices[0]?.action).toBeUndefined()

  useWorkspaceStore.setState({ notices: [] })
  merged = merge({ worktreeId: 'c1', into: 'w1' })
  await store().mergeIntoBase('c1')
  expect(store().notices).toEqual([])
})

it('says why an Undo was refused', async () => {
  call.mockImplementation((method: unknown) =>
    method === 'project.resetBase' ? Promise.reject(new Error('main was pushed')) : new Promise(() => {})
  )
  await store().undo({ kind: 'land', projectId: 'p1', head: HEAD, before: BEFORE })
  expect(store().notices[0]).toMatchObject({ text: 'Could not undo the merge: main was pushed', tone: 'error' })
})

it('drops the Undo once main has moved or been pushed', () => {
  const action = { label: 'Undo', undo: { kind: 'land' as const, projectId: 'p1', head: HEAD, before: BEFORE } }
  expect(liveAction(action, {})).toBe(action)
  expect(liveAction(action, { p1: base() })).toBe(action)
  expect(liveAction(action, { p1: base({ upstream: undefined, ahead: 0 }) })).toBe(action)
  expect(liveAction(action, { p1: base({ head: 'c'.repeat(40), ahead: 2 }) })).toBeUndefined()
  expect(liveAction(action, { p1: base({ ahead: 0 }) })).toBeUndefined()
})
