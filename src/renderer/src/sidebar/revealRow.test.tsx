/** @vitest-environment jsdom */

// Picking a worktree anywhere brings its sidebar row into view: its project and parent tasks unfold,
// and the list scrolls to it. The palette, the board and search open a worktree; a notice and the
// board's pane rows reveal a pane; the next-worktree chord steps.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useTaskTreeStore } = await import('../state/taskTreeStore')
const { useSidebarView } = await import('../state/sidebarViewStore')
const { Sidebar } = await import('./Sidebar')

const INITIAL = useWorkspaceStore.getState()
const VIEW = useSidebarView.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

const project = (id: string): Project => ({ id, name: id, path: `/repos/${id}`, baseRef: 'origin/main' })

const worktree = (id: string, projectId: string, parentId?: string): Worktree => ({
  id,
  projectId,
  name: id,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  ...(parentId === undefined ? {} : { parentId })
})

const scrolled = vi.fn<(element: Element) => void>()

beforeEach(() => {
  scrolled.mockReset()
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this)
  }
  useSidebarView.setState(VIEW, true)
  useTaskTreeStore.setState({ collapsedTasks: { parent: true } })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      restoring: false,
      projects: [project('p1'), project('p2')],
      worktrees: [worktree('first', 'p1'), worktree('parent', 'p2'), worktree('leaf', 'p2', 'parent')],
      collapsedProjects: { p2: true },
      activeWorktreeId: 'parent',
      openWorktreeIds: ['parent']
    },
    true
  )
})

afterEach(cleanup)

const rowOf = (id: string): Element | null => document.querySelector(`[data-worktree-id="${id}"] .worktree__row`)

describe('a worktree picked from anywhere', () => {
  it.each([
    ['the palette, the board and search (open)', () => void store().openWorktree('leaf')],
    ['a notice and a board pane row (reveal a pane)', () => void store().revealPane('leaf', 't1')],
    ['the next-worktree chord (step)', () => store().stepWorktree(1)]
  ])('from %s unfolds its project and parents, and scrolls its row into view', (_, pick) => {
    render(<Sidebar searchHint="⌘K" />)
    expect(rowOf('leaf')).toBeNull()
    scrolled.mockReset()

    act(pick)

    expect(store().collapsedProjects.p2).toBe(false)
    expect(useTaskTreeStore.getState().collapsedTasks.parent).toBeUndefined()
    const row = rowOf('leaf')
    expect(row).not.toBeNull()
    expect(scrolled).toHaveBeenCalledWith(row)
  })

  it('stays in view while the filter would hide it', () => {
    useSidebarView.setState({ query: 'first' })
    render(<Sidebar searchHint="⌘K" />)
    act(() => void store().openWorktree('leaf'))
    expect(rowOf('leaf')).not.toBeNull()
    expect(rowOf('parent')).not.toBeNull()
  })

  // `tax rules` stayed under `ind`: typing a filter hides the open row it does not match, and it stays open.
  it('is hidden by the next filter that does not match it', () => {
    useWorkspaceStore.setState({ collapsedProjects: {} })
    render(<Sidebar searchHint="⌘K" />)
    act(() => void store().openWorktree('leaf'))
    act(() => useSidebarView.getState().setQuery('first'))
    expect(rowOf('leaf')).toBeNull()
    expect(rowOf('first')).not.toBeNull()
    expect(store().activeWorktreeId).toBe('leaf')
    act(() => useSidebarView.getState().setQuery(''))
    expect(rowOf('leaf')).not.toBeNull()
  })

  it('is not kept on screen by a filter it does not match when nothing picked it', () => {
    useWorkspaceStore.setState({ collapsedProjects: {} })
    useSidebarView.setState({ query: 'first' })
    render(<Sidebar searchHint="⌘K" />)
    expect(rowOf('parent')).toBeNull()
    expect(rowOf('first')).not.toBeNull()
  })
})
