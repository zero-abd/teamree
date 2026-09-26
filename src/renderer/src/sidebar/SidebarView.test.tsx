/** @vitest-environment jsdom */

// The sidebar at a hundred rows: a filter field, quick-filter chips, Compact, and done rows folded
// per project. Every choice is this window's and survives a relaunch.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TeammatePresence, Terminal, Worktree } from '@shared/entities'

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
const { runWorkspaceCommand } = await import('../keyboard/workspaceCommands')
const { Sidebar } = await import('./Sidebar')

const INITIAL = useWorkspaceStore.getState()
const VIEW = useSidebarView.getState()
const NOW = Date.now()

const project = (id: string): Project => ({ id, name: id, path: `/repos/${id}`, baseRef: 'origin/main' })

const worktree = (id: string, overrides: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name: id,
  branch: `${id}-branch`,
  path: `/wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: NOW,
  ...overrides
})

const pane = (id: string, worktreeId: string, busy: boolean): Terminal => ({
  id,
  worktreeId,
  title: 'claude',
  agent: 'claude',
  cwd: `/wt/${worktreeId}`,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy,
  lastOutputAt: NOW
})

const done = { outcome: 'succeeded' as const, summary: 'Finished.', paths: [], at: NOW }

const status = (worktreeId: string, unstaged: number) => ({
  worktreeId,
  branch: `${worktreeId}-branch`,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged,
  untracked: 0,
  conflicted: 0,
  readAt: NOW
})

const teammates: TeammatePresence = {
  state: 'read',
  projectId: 'p1',
  teammates: [],
  readAt: NOW,
  worktrees: [
    {
      id: 'ana:w1',
      name: 'ana task',
      branch: 'ana-task',
      state: 'ready',
      panes: [],
      handle: 'ana',
      publicKey: 'ana-key',
      heardAt: NOW,
      live: true
    }
  ]
}

const names = (): string[] =>
  [...document.querySelectorAll('[data-worktree-id]')].map((row) => row.getAttribute('data-worktree-id') ?? '')

const field = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Filter worktrees' })
const chip = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  useSidebarView.setState(VIEW, true)
  useTaskTreeStore.setState({ collapsedTasks: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      restoring: false,
      projects: [project('p1'), project('p2')],
      worktrees: [
        worktree('checkout', { name: 'Checkout tax', issue: { number: 412, url: 'https://x/412' } }),
        worktree('cart', { parentId: 'checkout', name: 'Cart totals' }),
        worktree('ghost', { name: 'Ghost rows', branch: 'ui/ghost' }),
        worktree('shipped', { report: done }),
        worktree('merged'),
        worktree('elsewhere', { projectId: 'p2' })
      ],
      terminals: { t1: pane('t1', 'ghost', true), t2: pane('t2', 'cart', false) },
      statuses: { cart: status('cart', 3) },
      landings: { merged: { merged: true } as never },
      teammates: { p1: teammates }
    },
    true
  )
})

afterEach(cleanup)

const mount = (): void => void render(<Sidebar searchHint="⌘K" />)

describe('the filter field', () => {
  it('keeps matching rows and their parents, and leaves out projects with none', () => {
    mount()
    fireEvent.change(field(), { target: { value: 'cart' } })
    expect(names()).toEqual(['checkout', 'cart'])
    expect(document.querySelector('[data-project-id="p2"]')).toBeNull()
    expect(document.querySelector('[data-worktree-id="checkout"]')?.className).toContain('worktree--context')
  })

  it('matches a branch and an issue number', () => {
    mount()
    fireEvent.change(field(), { target: { value: 'ui/gh' } })
    expect(names()).toEqual(['ghost'])
    fireEvent.change(field(), { target: { value: '#412' } })
    expect(names()).toEqual(['checkout'])
  })

  it('says so when nothing matches', () => {
    mount()
    fireEvent.change(field(), { target: { value: 'zzz' } })
    expect(names()).toEqual([])
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('is reached with / from the list, and Escape clears it', () => {
    mount()
    const row = screen.getAllByRole('treeitem')[1] as HTMLElement
    act(() => row.focus())
    fireEvent.keyDown(row, { key: '/' })
    expect(document.activeElement).toBe(field())
    fireEvent.change(field(), { target: { value: 'ghost' } })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('')
  })

  it('is reached with Filter Sidebar', () => {
    mount()
    act(() => runWorkspaceCommand('filter-sidebar', useWorkspaceStore.getState()))
    expect(document.activeElement).toBe(field())
  })

  it('is remembered for this window', () => {
    mount()
    fireEvent.change(field(), { target: { value: 'ghost' } })
    expect(JSON.parse(localStorage.getItem('teamree.sidebar.view') ?? '{}').query).toBe('ghost')
  })
})

describe('the chips', () => {
  it('Working keeps the rows with a pane at work', () => {
    mount()
    fireEvent.click(chip('Working'))
    expect(chip('Working').getAttribute('aria-pressed')).toBe('true')
    expect(names()).toEqual(['ghost'])
  })

  it('Changed keeps the rows with uncommitted work', () => {
    mount()
    fireEvent.click(chip('Changed'))
    expect(names()).toEqual(['checkout', 'cart'])
  })

  it('Needs You keeps asking and failed rows', () => {
    useWorkspaceStore.setState((state) => ({
      worktrees: [...state.worktrees, worktree('broken', { state: 'failed', error: 'git exited with code 1: no' })]
    }))
    mount()
    fireEvent.click(chip('Needs You'))
    expect(names()).toEqual(['broken'])
  })

  it('Mine leaves teammates’ rows out', () => {
    mount()
    expect(screen.getByText('ana task')).toBeTruthy()
    fireEvent.click(chip('Mine'))
    expect(screen.queryByText('ana task')).toBeNull()
  })

  it('Hide Done folds done and landed rows into a count per project, which unfolds', () => {
    mount()
    fireEvent.click(chip('Hide Done'))
    expect(names()).not.toContain('shipped')
    expect(names()).not.toContain('merged')
    const fold = screen.getByRole('treeitem', { name: '2 done' })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fold)
    expect(names()).toContain('shipped')
    expect(names()).toContain('merged')
    expect(screen.getByRole('treeitem', { name: '2 done' }).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('Compact', () => {
  it('draws each row on one line, without its pane rows or branch line', () => {
    mount()
    expect(document.querySelector('[data-worktree-id="ghost"] .pane-row')).not.toBeNull()
    expect(document.querySelector('[data-worktree-id="ghost"] .worktree__meta')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
    expect(screen.getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-worktree-id="ghost"] .pane-row')).toBeNull()
    expect(document.querySelector('[data-worktree-id="ghost"] .worktree__meta')).toBeNull()
    expect(document.querySelector('[data-worktree-id="shipped"] .worktree__report')).toBeNull()
    expect(document.querySelector('.sidebar--compact')).not.toBeNull()
  })
})
