/** @vitest-environment jsdom */

// The panel on the right of the panes, for the things only it decides: which
// tab is up, whether the panel is, and that both survive a change of worktree
// while the content does not.
//
// The files tab is exercised through the panel rather than on its own, because
// what it promises is a path: the file somebody clicked, under the checkout the
// panel is showing, handed to the editor the store already knows how to open.
// A tree that drew the right names and opened the wrong path would pass any
// test written against the names.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileColumnIn, fileLeavesIn } from '@shared/filePane'
import type {
  Layout,
  Project,
  Terminal,
  Worktree,
  WorktreeChanges,
  WorktreeFiles,
  WorktreeStatus
} from '@shared/entities'

const call = vi.fn()

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { RightPanel } = await import('./RightPanel')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  ...overrides
})

const terminal = (worktreeId: string): Terminal => ({
  id: `t-${worktreeId}`,
  worktreeId,
  title: 'zsh',
  cwd: '/repos/pager-wt',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0
})

const layout = (worktreeId: string): Layout => ({
  worktreeId,
  root: { kind: 'leaf', terminalId: `t-${worktreeId}` },
  focusedTerminalId: `t-${worktreeId}`
})

/** The chips' counts, which the Changes badge on the rail is drawn from. */
const status: WorktreeStatus = {
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 1,
  untracked: 1,
  conflicted: 0,
  readAt: 0
}

const changes: WorktreeChanges = {
  worktreeId: 'w1',
  changes: [
    { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
    { path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }
  ],
  total: 2,
  limit: 500,
  truncated: false,
  readAt: 0
}

/** What the runtime lists for each directory of the fixture checkout. */
const LISTINGS: Record<string, WorktreeFiles['entries']> = {
  '': [
    { name: 'dist', kind: 'dir', ignored: true },
    { name: 'src', kind: 'dir', ignored: false },
    { name: 'README.md', kind: 'file', ignored: false }
  ],
  src: [{ name: 'app.ts', kind: 'file', ignored: false }]
}

function answer(method: string, params: unknown): Promise<unknown> {
  const asked = params as { worktreeId: string; path?: string; query?: string }
  if (method === 'worktree.files') {
    return Promise.resolve({
      worktreeId: asked.worktreeId,
      path: asked.path ?? '',
      entries: LISTINGS[asked.path ?? ''] ?? [],
      truncated: false,
      readAt: 0
    })
  }
  if (method === 'worktree.findFiles') {
    const wanted = (asked.query ?? '').toLowerCase()
    return Promise.resolve({
      worktreeId: asked.worktreeId,
      query: asked.query,
      paths: ['README.md', 'src/app.ts'].filter((path) => path.toLowerCase().includes(wanted)),
      truncated: false,
      readAt: 0
    })
  }
  if (method === 'editor.open') return Promise.resolve({ opened: true, editor: 'code' })
  // Anything else — changes, logs, tails — is left pending; nothing here
  // depends on it.
  return new Promise(() => {})
}

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [worktree(), worktree({ id: 'w2', name: 'Fix the index', path: '/repos/pager-wt/index' })],
      activeWorktreeId: 'w1',
      openWorktreeIds: ['w1', 'w2'],
      layouts: { w1: layout('w1'), w2: layout('w2') },
      terminals: { 't-w1': terminal('w1'), 't-w2': terminal('w2') },
      changes: { w1: changes },
      statuses: { w1: status },
      rightPanelOpen: false,
      rightPanelTab: 'files',
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<RightPanel />)
}

const filesCalls = (): unknown[] => call.mock.calls.filter(([method]) => method === 'worktree.files').map(([, p]) => p)

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(answer)
  window.localStorage.clear()
  seed()
})

describe('the rail', () => {
  it('is all there is while the panel is closed, and pressing a tab opens the panel on it', () => {
    mount()

    expect(screen.queryByRole('tabpanel')).toBeNull()
    for (const name of ['Files', 'Changes, 2']) {
      expect(screen.getByRole('tab', { name })).toHaveProperty('ariaSelected', 'false')
    }

    fireEvent.click(screen.getByRole('tab', { name: 'Changes, 2' }))

    expect(useWorkspaceStore.getState().rightPanelOpen).toBe(true)
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('changes')
    expect(screen.getByRole('tab', { name: 'Changes, 2' })).toHaveProperty('ariaSelected', 'true')
    expect(screen.getByRole('region', { name: 'Changes in this worktree' })).toBeTruthy()
  })

  // The sidebar and All Panes list the panes; a tab of the same rows was a third copy.
  it('has no Panes tab', () => {
    seed({ rightPanelOpen: true })
    mount()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Files', 'Changes2'])
  })

  it('switches between the two tabs, one at a time', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()

    expect(await screen.findByRole('region', { name: 'Files in this worktree' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Changes, 2' }))
    expect(screen.getByRole('region', { name: 'Changes in this worktree' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Files in this worktree' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(await screen.findByRole('region', { name: 'Files in this worktree' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Changes in this worktree' })).toBeNull()
  })

  it('folds on Hide panel and unfolds on Show panel, keeping the tab', () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'changes' })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)
    expect(screen.queryByRole('tabpanel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }))
    expect(useWorkspaceStore.getState().rightPanelOpen).toBe(true)
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('changes')
    expect(screen.getByRole('region', { name: 'Changes in this worktree' })).toBeTruthy()
  })

  // The chord and the menu item both land here; the rail is only the pointer's
  // way in.
  it('follows the store when the command toggles it', () => {
    mount()
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(screen.getByRole('tabpanel')).toBeTruthy()
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(screen.queryByRole('tabpanel')).toBeNull()
  })

  // One element open and closed, so its width slides between the two rather than snapping.
  it('keeps the same panel element as it opens and closes', () => {
    mount()
    const closed = document.querySelector('[data-region="panel"]')
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(document.querySelector('[data-region="panel"]')).toBe(closed)
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(document.querySelector('[data-region="panel"]')).toBe(closed)
  })

  // What a fresh launch reads back is what the last click wrote: the panel's
  // arrangement is a habit of this machine, like the sidebar's width.
  it('remembers the tab and whether it is open on this machine', () => {
    mount()
    fireEvent.click(screen.getByRole('tab', { name: 'Changes, 2' }))
    expect(JSON.parse(window.localStorage.getItem('teamree.shell.rightPanel') ?? '{}')).toEqual({
      open: true,
      tab: 'changes'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(JSON.parse(window.localStorage.getItem('teamree.shell.rightPanel') ?? '{}')).toEqual({
      open: false,
      tab: 'changes'
    })
  })

  it('remembers its width, clamped', () => {
    seed({ rightPanelOpen: true })
    mount()
    act(() => useWorkspaceStore.getState().setRightPanelWidth(9999))
    expect(screen.getByRole('separator', { name: 'Resize right panel' })).toHaveProperty('ariaValueNow', '720')
    expect(window.localStorage.getItem('teamree.shell.rightPanelWidth')).toBe('720')
  })

  it('labels its tabs in words when open, with counts as pills', () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'changes' })
    mount()

    for (const [name, label, count] of [
      ['Files', 'Files', null],
      ['Changes, 2', 'Changes', '2']
    ] as const) {
      const tab = screen.getByRole('tab', { name })
      expect(tab.querySelector('.panel__tabLabel')?.textContent).toBe(label)
      expect(tab.querySelector('.panel__count')?.textContent ?? null).toBe(count)
      expect(tab.querySelector('svg')).toBeNull()
    }
  })

  it('draws icons with tooltips down the edge when closed', () => {
    mount()
    const tab = screen.getByRole('tab', { name: 'Changes, 2' })
    expect(tab.querySelector('svg')).not.toBeNull()
    expect(tab.querySelector('.panel__tabLabel')).toBeNull()
    expect(tab.title).toBe('Changes')
    expect(tab.querySelector('.panel__count')?.textContent).toBe('2')
  })

  it('keeps its width across a change of worktree and a fold', () => {
    seed({ rightPanelOpen: true })
    mount()
    act(() => useWorkspaceStore.getState().setRightPanelWidth(480))

    act(() => useWorkspaceStore.setState({ activeWorktreeId: 'w2' }))
    expect(screen.getByRole('complementary', { name: 'Right panel' }).style.width).toBe('480px')

    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }))
    expect(screen.getByRole('separator', { name: 'Resize right panel' })).toHaveProperty('ariaValueNow', '480')
  })
})

describe('the files tab', () => {
  it('lists the root as the runtime answered, dims what git ignores, and letters what changed', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()

    const tree = await screen.findByRole('tree', { name: 'Files' })
    await within(tree).findByText('README.md')
    expect(filesCalls()).toEqual([{ worktreeId: 'w1' }])

    const items = within(tree).getAllByRole('treeitem')
    expect(items.map((item) => item.textContent)).toEqual(['dist', 'src', 'README.mdM'])
    expect(items[0]?.querySelector('.tree__item--ignored')).not.toBeNull()
    expect(items[1]?.querySelector('.tree__item--ignored')).toBeNull()
    // The same letter the changes tab prints for the same path.
    expect(within(items[2] as HTMLElement).getByText('M').className).toContain('change__kind--modified')
  })

  it('reads a folder when it is opened, and again when it is reopened', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()
    const tree = await screen.findByRole('tree', { name: 'Files' })
    await within(tree).findByText('src')

    fireEvent.click(within(tree).getByRole('button', { name: /^src/ }))
    await within(tree).findByText('app.ts')
    expect(filesCalls()).toEqual([{ worktreeId: 'w1' }, { worktreeId: 'w1', path: 'src' }])

    // Folded: the row goes, the listing stays.
    fireEvent.click(within(tree).getByRole('button', { name: /^src/ }))
    expect(within(tree).queryByText('app.ts')).toBeNull()

    // No watcher, so opening it again is what asks for a fresh read.
    fireEvent.click(within(tree).getByRole('button', { name: /^src/ }))
    await waitFor(() => expect(filesCalls()).toHaveLength(3))
    expect(within(tree).getByText('app.ts')).toBeTruthy()
  })

  it('previews a file on a click, and keeps it on a double-click', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files', editorCommands: { p1: 'mate' } })
    mount()
    const tree = await screen.findByRole('tree', { name: 'Files' })
    await within(tree).findByText('README.md')
    const paths = (): string[] => fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root).map((leaf) => leaf.path)
    const row = (name: RegExp): HTMLElement => within(tree).getByRole('button', { name })

    fireEvent.click(row(/^README\.md/))
    await waitFor(() => expect(call).toHaveBeenCalledWith('layout.set', expect.objectContaining({ worktreeId: 'w1' })))
    const layout = useWorkspaceStore.getState().layouts.w1!
    expect(paths()).toEqual(['README.md'])
    expect(layout.focusedTerminalId).toBe(fileLeavesIn(layout.root)[0]?.terminalId)

    fireEvent.click(row(/^src/))
    fireEvent.click(await within(tree).findByRole('button', { name: /^app\.ts/ }))
    expect(paths()).toEqual(['src/app.ts'])

    fireEvent.doubleClick(row(/^app\.ts/))
    fireEvent.click(row(/^README\.md/))
    expect(paths()).toEqual(['src/app.ts', 'README.md'])

    expect(call).not.toHaveBeenCalledWith('editor.open', expect.anything())
  })

  it('splits a file beside the focused pane on ⌘-click, and from the row menu', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()
    const tree = await screen.findByRole('tree', { name: 'Files' })
    fireEvent.click(await within(tree).findByRole('button', { name: /^README\.md/ }), { metaKey: true })
    fireEvent.click(within(tree).getByRole('button', { name: /^src/ }))
    fireEvent.contextMenu(await within(tree).findByRole('button', { name: /^app\.ts/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open to the Side' }))
    const root = useWorkspaceStore.getState().layouts.w1!.root
    expect(fileColumnIn(root)).toBeNull()
    expect(root).toMatchObject({ kind: 'split', direction: 'row' })
    expect(
      root?.kind === 'split' && root.children.map((child) => child.kind === 'leaf' && (child.path ?? 't'))
    ).toEqual(['t', 'README.md', 'src/app.ts'])
  })

  it('still opens a file in the editor from its row menu', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files', editorCommands: { p1: 'mate' } })
    mount()
    const tree = await screen.findByRole('tree', { name: 'Files' })
    fireEvent.contextMenu(await within(tree).findByRole('button', { name: /^README\.md/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'mate' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('editor.open', { path: '/repos/pager-wt/rewrite/README.md', command: 'mate' })
    )
  })

  it('opens a markdown file as a pane beside the terminals rather than in the editor', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files', editorCommands: { p1: 'mate' } })
    mount()
    const tree = await screen.findByRole('tree', { name: 'Files' })
    await within(tree).findByText('README.md')

    fireEvent.click(within(tree).getByRole('button', { name: /^README\.md/ }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('layout.set', expect.objectContaining({ worktreeId: 'w1' })))
    const layout = useWorkspaceStore.getState().layouts.w1!
    expect(fileLeavesIn(layout.root).map((leaf) => leaf.path)).toEqual(['README.md'])
    expect(layout.focusedTerminalId).toBe(fileLeavesIn(layout.root)[0]?.terminalId)
    expect(call).not.toHaveBeenCalledWith('editor.open', expect.anything())
  })

  it('finds files by name through the runtime, and opens one the same way', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()
    await screen.findByRole('tree', { name: 'Files' })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find files' }), { target: { value: 'app' } })
    const found = await screen.findByRole('list', { name: 'Files matching app' })
    expect(call).toHaveBeenCalledWith('worktree.findFiles', { worktreeId: 'w1', query: 'app', limit: 200 })
    expect(
      within(found)
        .getAllByRole('button')
        .map((row) => row.textContent)
    ).toEqual(['src/app.ts?'])

    fireEvent.click(within(found).getByRole('button'))
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root).map((leaf) => leaf.path)).toEqual(['src/app.ts'])

    // Clearing the field brings the tree back.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find files' }), { target: { value: '' } })
    expect(screen.getByRole('tree', { name: 'Files' })).toBeTruthy()
  })

  // The tab is the machine's; the tree is the worktree's.
  it('keeps the tab and reads the other checkout when the worktree changes', async () => {
    seed({ rightPanelOpen: true, rightPanelTab: 'files' })
    mount()
    await screen.findByRole('tree', { name: 'Files' })
    await waitFor(() => expect(filesCalls()).toEqual([{ worktreeId: 'w1' }]))

    act(() => useWorkspaceStore.setState({ activeWorktreeId: 'w2' }))

    await waitFor(() => expect(filesCalls()).toEqual([{ worktreeId: 'w1' }, { worktreeId: 'w2' }]))
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('files')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveProperty('ariaSelected', 'true')
  })
})
