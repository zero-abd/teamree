/** @vitest-environment jsdom */

// The pane menu, from a tab and from a pane header: each kind of pane gets the rows that make sense
// for it, every row acts on the pane pointed at rather than the focused one, and the keyboard can
// raise, walk and dismiss it. The Files tab's rows share its Open in submenu.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneNode, Terminal, Worktree, WorktreeFiles } from '@shared/entities'
import { fileLeaf } from '@shared/filePane'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { leaf } from '../panes/paneLayout'

const listing: WorktreeFiles = {
  worktreeId: 'w1',
  path: '',
  entries: [
    { name: 'src', kind: 'dir', ignored: false },
    { name: 'README.md', kind: 'file', ignored: false }
  ],
  truncated: false,
  readAt: 0
}

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string) => (method === 'worktree.files' ? Promise.resolve(listing) : new Promise(() => {})),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

vi.mock('../terminal/TerminalView', () => ({ TerminalView: () => <div /> }))
// The viewer's own header, handed the menu the tree gives it.
vi.mock('../files/FileView', () => ({
  FileView: ({ onHeaderMenu }: { onHeaderMenu?: (event: React.MouseEvent<HTMLElement>) => void }) => (
    <header data-testid="file-header" onContextMenu={onHeaderMenu} />
  ),
  FileGlyph: () => <span />
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { TerminalTabs } = await import('./TerminalTabs')
const { PaneTree } = await import('../panes/PaneTree')
const { FilesTab } = await import('./rightPanel/FilesTab')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

const worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'rewrite',
  branch: 'rewrite',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
} as Worktree

const terminal = (overrides: Partial<Terminal> & { id: string }): Terminal => ({
  worktreeId: 'w1',
  title: 'zsh',
  cwd: worktree.path,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

const row = (...children: PaneNode[]): PaneNode => ({
  kind: 'split',
  direction: 'row',
  sizes: children.map(() => 1 / children.length),
  children
})

const actions = {
  focusPane: vi.fn(),
  splitFocusedPane: vi.fn(async () => {}),
  expandPane: vi.fn(),
  relaunchTerminal: vi.fn(async () => {}),
  copyPaneOutput: vi.fn(async () => {}),
  closeTerminal: vi.fn(async () => {}),
  closeOtherPanes: vi.fn(async () => {}),
  copyToClipboard: vi.fn(async () => {}),
  revealInFinder: vi.fn(async () => {}),
  openInEditor: vi.fn(async () => {}),
  setEditorCommand: vi.fn(),
  loadEditors: vi.fn(async () => {})
}

const README = fileLeaf('file:readme', 'README.md')

function seed(root: PaneNode, overrides: Record<string, unknown> = {}): void {
  const layout: Layout = { worktreeId: 'w1', root, focusedTerminalId: 't1' }
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      ...actions,
      activeWorktreeId: 'w1',
      worktrees: [worktree],
      layouts: { w1: layout },
      terminals: {
        t1: terminal({ id: 't1', title: 'npm test' }),
        t2: terminal({ id: 't2', agent: 'claude' })
      },
      editors: [
        { command: 'com.todesktop.230313mzl4w4u92', label: 'Cursor', kind: 'editor' },
        { command: 'com.apple.Terminal', label: 'Terminal', kind: 'terminal' },
        { command: 'com.apple.finder', label: 'Finder', kind: 'finder' }
      ],
      ...overrides
    },
    true
  )
}

const rows = (menu: HTMLElement): { label: string; hint: string | null }[] =>
  within(menu)
    .getAllByRole('menuitem')
    .filter((item) => item.parentElement === menu)
    .map((item) => ({
      label: item.querySelector('.row-menu__label')?.textContent ?? '',
      hint: item.querySelector('.row-menu__hint')?.textContent ?? null
    }))

const labels = (menu: HTMLElement): string[] => rows(menu).map((entry) => entry.label)

const rightClickTab = (name: string): HTMLElement => {
  fireEvent.contextMenu(screen.getByRole('tab', { name }), { clientX: 40, clientY: 20 })
  return screen.getByRole('menu', { name: `Actions for ${name}` })
}

const choose = (menu: HTMLElement, label: string): void => {
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }))
}

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockClear()
})

afterEach(cleanup)

describe('a terminal tab', () => {
  beforeEach(() => {
    seed(row(leaf('t1'), leaf('t2')))
    render(<TerminalTabs modifier={MAC} />)
  })

  it('offers the pane actions, each chord from the shortcut table', () => {
    expect(rows(rightClickTab('Claude Code'))).toEqual([
      { label: 'Rename…', hint: null },
      { label: 'Split Right', hint: '⌘D' },
      { label: 'Split Down', hint: '⌘⇧D' },
      { label: 'Maximize', hint: '⌘⇧↩' },
      { label: 'Copy Output', hint: null },
      { label: 'Close', hint: '⌘W' },
      { label: 'Close Others', hint: null }
    ])
  })

  it('splits the pane pointed at, not the focused one', () => {
    choose(rightClickTab('Claude Code'), 'Split Down')
    expect(actions.focusPane).toHaveBeenCalledExactlyOnceWith('t2')
    expect(actions.splitFocusedPane).toHaveBeenCalledExactlyOnceWith('column')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('maximises, copies, closes and closes the others for that pane', () => {
    choose(rightClickTab('Claude Code'), 'Maximize')
    choose(rightClickTab('Claude Code'), 'Copy Output')
    choose(rightClickTab('Claude Code'), 'Close')
    choose(rightClickTab('Claude Code'), 'Close Others')
    expect(actions.expandPane).toHaveBeenCalledExactlyOnceWith('t2')
    expect(actions.copyPaneOutput).toHaveBeenCalledExactlyOnceWith('t2', 'Claude Code')
    expect(actions.closeTerminal).toHaveBeenCalledExactlyOnceWith('t2')
    expect(actions.closeOtherPanes).toHaveBeenCalledExactlyOnceWith('t2')
  })

  it('opens the name field on that tab from Rename…', () => {
    choose(rightClickTab('npm test'), 'Rename…')
    expect((screen.getByRole('textbox', { name: 'Pane name' }) as HTMLInputElement).value).toBe('npm test')
  })

  it('opens from ⇧F10 on the focused tab, walks with the arrows and gives the focus back on Escape', () => {
    const tab = screen.getByRole('tab', { name: 'npm test' })
    tab.focus()
    fireEvent.keyDown(tab, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Actions for npm test' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: /Split Right/ }))
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tab)
  })

  it('opens from the context-menu key too', () => {
    fireEvent.keyDown(screen.getByRole('tab', { name: 'npm test' }), { key: 'ContextMenu' })
    expect(screen.getByRole('menu', { name: 'Actions for npm test' })).toBeTruthy()
  })
})

describe('the rows that depend on the pane', () => {
  it('offers Run Again on an exited pane only, and Restore on the maximised one', () => {
    seed(row(leaf('t1'), leaf('t2')), {
      terminals: {
        t1: terminal({ id: 't1', title: 'npm test', running: false, exitCode: 1 }),
        t2: terminal({ id: 't2', agent: 'claude' })
      },
      expandedTerminalId: 't1'
    })
    render(<TerminalTabs modifier={MAC} />)
    const menu = rightClickTab('npm test')
    expect(labels(menu)).toEqual([
      'Rename…',
      'Split Right',
      'Split Down',
      'Restore',
      'Run Again',
      'Copy Output',
      'Close',
      'Close Others'
    ])
    choose(menu, 'Run Again')
    expect(actions.relaunchTerminal).toHaveBeenCalledExactlyOnceWith('t1')
    expect(labels(rightClickTab('Claude Code'))).not.toContain('Run Again')
  })

  it('leaves Close Others out when there are no others', () => {
    seed(leaf('t1'))
    render(<TerminalTabs modifier={MAC} />)
    expect(labels(rightClickTab('npm test'))).not.toContain('Close Others')
  })
})

describe('a file tab', () => {
  beforeEach(() => {
    seed(row(leaf('t1'), README))
    render(<TerminalTabs modifier={MAC} />)
  })

  it('offers what can be done to a file, and nothing a terminal has', () => {
    expect(labels(rightClickTab('README.md'))).toEqual([
      'Copy path',
      'Reveal in Finder',
      'Open in',
      'Maximize',
      'Close',
      'Close Others'
    ])
  })

  it('copies and reveals the file by its absolute path', () => {
    choose(rightClickTab('README.md'), 'Copy path')
    choose(rightClickTab('README.md'), 'Reveal in Finder')
    expect(actions.copyToClipboard).toHaveBeenCalledWith(`${worktree.path}/README.md`, 'the path to README.md')
    expect(actions.revealInFinder).toHaveBeenCalledWith(`${worktree.path}/README.md`, 'README.md')
  })

  it('opens it in an editor only, which becomes the project’s', () => {
    const menu = rightClickTab('README.md')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open in' }))
    const sub = screen.getByRole('menu', { name: 'Open in' })
    expect(
      within(sub)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Cursor'])
    fireEvent.click(within(sub).getByRole('menuitem', { name: 'Cursor' }))
    expect(actions.openInEditor).toHaveBeenCalledExactlyOnceWith(
      `${worktree.path}/README.md`,
      'com.todesktop.230313mzl4w4u92',
      'README.md'
    )
    expect(actions.setEditorCommand).toHaveBeenCalledExactlyOnceWith('p1', 'com.todesktop.230313mzl4w4u92')
  })
})

describe('a pane header', () => {
  const mount = (root: PaneNode): void => {
    seed(root)
    const layout = useWorkspaceStore.getState().layouts.w1!
    render(
      <PaneTree
        node={layout.root!}
        path={[]}
        worktreeId="w1"
        terminals={useWorkspaceStore.getState().terminals}
        focusedTerminalId="t1"
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onRelaunch={vi.fn()}
        onResize={vi.fn()}
        isAppChord={() => false}
        modifier={MAC}
        searchTerminalId={null}
        searchToken={0}
        onCloseSearch={vi.fn()}
      />
    )
  }

  it('opens the same menu on a terminal pane, acting on that pane', () => {
    mount(row(leaf('t1'), leaf('t2')))
    const header = screen.getByRole('region', { name: 'Claude Code' }).querySelector('header')!
    fireEvent.contextMenu(header, { clientX: 300, clientY: 60 })
    const menu = screen.getByRole('menu', { name: 'Actions for Claude Code' })
    expect(labels(menu)).toContain('Copy Output')
    choose(menu, 'Copy Output')
    expect(actions.copyPaneOutput).toHaveBeenCalledExactlyOnceWith('t2', 'Claude Code')
  })

  it('opens the file menu on a file pane', () => {
    mount(row(leaf('t1'), fileLeaf('file:app', 'src/app.ts')))
    fireEvent.contextMenu(screen.getByTestId('file-header'), { clientX: 300, clientY: 60 })
    expect(labels(screen.getByRole('menu', { name: 'Actions for app.ts' }))).toEqual([
      'Copy path',
      'Reveal in Finder',
      'Open in',
      'Maximize',
      'Close',
      'Close Others'
    ])
  })
})

describe('a row of the Files tab', () => {
  const openInFor = async (name: string): Promise<string[]> => {
    fireEvent.contextMenu(await screen.findByRole('button', { name: new RegExp(`^${name}`) }), {
      clientX: 900,
      clientY: 200
    })
    const menu = screen.getByRole('menu')
    expect(labels(menu)).toEqual(['Copy path', 'Reveal in Finder', 'Open in'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open in' }))
    return within(screen.getByRole('menu', { name: 'Open in' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '')
  }

  beforeEach(() => {
    seed(leaf('t1'))
    render(<FilesTab worktree={worktree} />)
  })

  it('offers a file to the editors only', async () => {
    expect(await openInFor('README.md')).toEqual(['Cursor'])
  })

  it('offers a folder to the editors, terminals and Finder', async () => {
    expect(await openInFor('src')).toEqual(['Cursor', 'Terminal', 'Finder'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }))
    expect(actions.openInEditor).toHaveBeenCalledExactlyOnceWith(`${worktree.path}/src`, 'com.apple.Terminal', 'src')
    expect(actions.setEditorCommand).not.toHaveBeenCalled()
  })
})
