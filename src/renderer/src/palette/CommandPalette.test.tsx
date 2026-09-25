/** @vitest-environment jsdom */

// The palette as assembled: what its rows do when they are chosen.
//
// The ranking and the wording are covered in `paletteModel.test.ts`, which is
// where they live. What is only true of the wired-up palette is here, and the
// reason this file exists is the agents: the toolbar over a worktree used to
// carry one button each, and this is now the only way to start one in a
// worktree that already has panes. A row that looks right and runs nothing is
// the failure this guards against.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledAgent, Project, Worktree } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { CommandPalette } = await import('./CommandPalette')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

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

const agents: InstalledAgent[] = [
  { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
  { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
]

const startAgent = vi.fn()
const openDialog = vi.fn()
const closeDialog = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      agents,
      startAgent,
      openDialog,
      closeDialog,
      ...overrides
    },
    true
  )
}

const mount = (mode: 'all' | 'files' = 'all'): void => {
  render(<CommandPalette modifier={MAC} mode={mode} />)
}

const rows = (): HTMLElement[] => screen.getAllByRole('option')

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  startAgent.mockReset()
  openDialog.mockReset()
  closeDialog.mockReset()
  localStorage.clear()
  seed()
})

describe('starting an agent from the palette', () => {
  it('offers one row per agent found on this machine', () => {
    mount()
    const labels = rows()
      .map((row) => row.querySelector('.palette__label')?.textContent ?? '')
      .filter((label) => label.startsWith('Start '))
    expect(labels).toEqual(['Start Claude Code Here', 'Start Codex Here'])
  })

  it('offers none when nothing is installed', () => {
    seed({ agents: [] })
    mount()
    expect(rows().some((row) => row.textContent?.includes('Start '))).toBe(false)
  })

  it('starts that agent in the worktree on screen, and closes', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'codex' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('codex')
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  // The one confusion worth guarding: both rows start an agent, and only this
  // one does it here. "New task" makes another worktree first.
  it('does not open the new-task dialog on the way', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'start claude' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('claude')
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('still opens the new-task dialog when that is the row chosen', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new task' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
    expect(startAgent).not.toHaveBeenCalled()
  })
})

const labels = (): string[] => rows().map((row) => row.querySelector('.palette__label')?.textContent ?? '')
const row = (label: string): HTMLElement =>
  rows().find((entry) => entry.querySelector('.palette__label')?.textContent === label) as HTMLElement
const trailingOf = (label: string): string => row(label).querySelector('.palette__trailing')?.textContent ?? ''
/** Why the row is dimmed, or null when it would run; typed, since what cannot run is listed only when searched. */
const reason = (label: string): string | null => {
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: label } })
  const found = row(label)
  const why = found.getAttribute('aria-disabled') === 'true' ? found.title : null
  fireEvent.change(input, { target: { value: '' } })
  return why
}

describe('the rows that are also commands', () => {
  // The window has no pane in it, so the pane commands would do nothing — the
  // same answer the menu bar gives, from the same predicate. Left out, and
  // dimmed only when a search finds nothing else.
  it('leaves out a command the window would refuse, dims it when searched, and runs nothing', () => {
    mount()
    expect(labels()).not.toContain('Split Pane Right')
    expect(labels()).toContain('New Terminal')
    expect(reason('Split Pane Right')).toBe('no pane focused')
    expect(reason('New Task')).toBeNull()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'save' } })
    expect(labels()).toEqual(['Save', 'Save All'])
    expect(trailingOf('Save')).toBe('')
    expect(row('Save').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(rows()[0] as HTMLElement)
    expect(closeDialog).not.toHaveBeenCalled()
  })

  it('offers the pane commands once there is a pane', () => {
    seed({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
    })
    mount()
    expect(reason('Split Pane Right')).toBeNull()
  })

  // Through the one dispatcher, which is the only way a row and a chord stay
  // the same command.
  it('runs the row through the dispatcher the chord goes through', () => {
    const splitFocusedPane = vi.fn(() => Promise.resolve())
    seed({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      splitFocusedPane
    })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'split right' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(splitFocusedPane).toHaveBeenCalledExactlyOnceWith('row')
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  // Straight to the OS picker; cloning is its own row.
  it('adds a project from the picker, and clones from a row of its own', () => {
    const chooseProjectFolder = vi.fn(() => Promise.resolve())
    seed({ chooseProjectFolder })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add project' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(chooseProjectFolder).toHaveBeenCalledOnce()
    expect(openDialog).not.toHaveBeenCalled()
    cleanup()

    seed({ chooseProjectFolder })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'clone repository' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'clone-project' })
  })
})

// The rows the palette gained from the command table, and the predicate that
// decides whether each is on offer. Same answer as the menu bar's, because it
// is the same function: a row for a command the window would refuse is left out
// rather than drawn and ignored.
describe('the git rows are offered exactly when they could do something', () => {
  const status = (overrides: Record<string, number> = {}): Record<string, unknown> => ({
    w1: {
      worktreeId: 'w1',
      branch: 'rewrite-the-pager',
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      readAt: 0,
      ...overrides
    }
  })

  it('dims both on a worktree with nothing to send and nothing changed', () => {
    seed({ statuses: status() })
    mount()
    expect(reason('Push')).toBe('nothing to push')
    expect(reason('Commit…')).toBe('no changes')
  })

  it('offers Push once there is a commit the remote has not', () => {
    seed({ statuses: status({ ahead: 1 }) })
    mount()
    expect(reason('Push')).toBeNull()
    expect(reason('Commit…')).toBe('no changes')
  })

  it('offers Commit… once a file has changed', () => {
    seed({ statuses: status({ unstaged: 2 }) })
    mount()
    expect(reason('Commit…')).toBeNull()
    expect(reason('Push')).toBe('nothing to push')
  })
})

describe('going to a file', () => {
  const INDEX = Array.from({ length: 40 }, (_, index) => `src/module${index}/big${index}.ts`)
  const openFilePane = vi.fn()

  beforeEach(() => {
    openFilePane.mockReset()
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method !== 'worktree.findFiles') return new Promise(() => {})
      const { query, limit } = params as { query: string; limit: number }
      const paths = INDEX.filter((path) => path.includes(query)).slice(0, limit)
      return Promise.resolve({ worktreeId: 'w1', query, paths, truncated: false, readAt: 0 })
    })
    seed({ openFilePane, recentFiles: { w1: ['docs/big-notes.md', 'README.md'] } })
  })

  const labels = (): string[] =>
    screen.queryAllByRole('option').map((row) => row.querySelector('.palette__label')?.textContent ?? '')
  const type = (value: string): void => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value } })
  }

  it('lists recent files and nothing else before anything is typed', () => {
    mount('files')
    expect(labels()).toEqual(['big-notes.md', 'README.md'])
  })

  it('asks the runtime for a fuzzy match, recent files first, and opens the chosen one like the tree', async () => {
    mount('files')
    type('big')
    await waitFor(() => expect(labels()).toContain('big0.ts'))
    expect(labels()[0]).toBe('big-notes.md')
    expect(call).toHaveBeenCalledWith('worktree.findFiles', expect.objectContaining({ worktreeId: 'w1', fuzzy: true }))

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(openFilePane).toHaveBeenCalledExactlyOnceWith('w1', 'src/module0/big0.ts', undefined)
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  it('opens it as a split with the modifier held', () => {
    mount('files')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(openFilePane).toHaveBeenCalledExactlyOnceWith('w1', 'docs/big-notes.md', 'split')
  })

  it('offers no commands and no worktrees in file mode', async () => {
    mount('files')
    type('new')
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(labels()).not.toContain('New Terminal')
  })

  it('adds up to five files under Files to the command results once two characters are typed', async () => {
    mount()
    type('b')
    expect(screen.queryByText('Files')).toBeNull()
    type('big')
    await waitFor(() => expect(screen.getByText('Files')).toBeTruthy())
    const files = rows().filter((row) => row.querySelector('.palette__trailing')?.textContent?.startsWith('src/'))
    expect(files.length).toBeLessThanOrEqual(5)
    expect(rows().length).toBeGreaterThan(0)
    // No longer "Nothing matches" for a file name.
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
  })

  it('says nothing matches only once the runtime has answered', async () => {
    mount('files')
    type('zzz')
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeTruthy())
  })
})

describe('the worktree on screen, from the palette', () => {
  const choose = (query: string): void => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: query } })
    fireEvent.click(rows()[0] as HTMLElement)
  }

  it('reveals, copies, forgets and trashes it through the sidebar row’s own actions', () => {
    const revealInFinder = vi.fn(() => Promise.resolve())
    const copyToClipboard = vi.fn(() => Promise.resolve())
    const removeWorktree = vi.fn(() => Promise.resolve())
    const removeFromTeamree = vi.fn(() => Promise.resolve())
    seed({ revealInFinder, copyToClipboard, removeWorktree, removeFromTeamree })
    mount()
    choose('reveal')
    expect(revealInFinder).toHaveBeenCalledExactlyOnceWith('/repos/pager-wt/rewrite', 'the Rewrite the pager checkout')
    choose('copy branch')
    expect(copyToClipboard).toHaveBeenCalledWith('rewrite-the-pager', 'the branch rewrite-the-pager')
    choose('move worktree to trash')
    expect(removeWorktree).toHaveBeenCalledExactlyOnceWith('w1')
    choose('remove worktree from teamree')
    expect(removeFromTeamree).toHaveBeenCalledExactlyOnceWith({ worktreeId: 'w1' })
  })

  it('asks the sidebar row for its name field', () => {
    seed({ sidebarVisible: false })
    mount()
    choose('rename')
    expect(useWorkspaceStore.getState()).toMatchObject({ editingWorktreeName: 'w1', sidebarVisible: true })
  })

  it('opens it in the project’s editor', () => {
    const openInEditor = vi.fn(() => Promise.resolve())
    seed({ openInEditor, editors: [{ label: 'Cursor', command: 'cursor', kind: 'editor' }] })
    mount()
    choose('open in cursor')
    expect(openInEditor).toHaveBeenCalledExactlyOnceWith(
      '/repos/pager-wt/rewrite',
      'cursor',
      'the Rewrite the pager checkout'
    )
  })

  it('discards or unstages the focused file', () => {
    const unstagePath = vi.fn(() => Promise.resolve())
    seed({
      unstagePath,
      layouts: {
        w1: {
          worktreeId: 'w1',
          root: { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'src/a.ts' },
          focusedTerminalId: 'file:1'
        }
      },
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: true }],
          total: 1,
          limit: 100,
          truncated: false,
          readAt: 0
        }
      }
    })
    mount()
    choose('discard')
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'confirm-discard', worktreeId: 'w1', path: 'src/a.ts' })
    choose('unstage')
    expect(unstagePath).toHaveBeenCalledExactlyOnceWith('w1', 'src/a.ts')
  })
})

describe('the focused file while the Changes list is unread', () => {
  it('asks the runtime about that one path', async () => {
    call.mockImplementation((method: unknown) =>
      Promise.resolve(
        method === 'worktree.changes'
          ? {
              worktreeId: 'w1',
              changes: [{ path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true }],
              total: 1,
              limit: 1,
              truncated: false,
              readAt: 0
            }
          : null
      )
    )
    seed({
      layouts: {
        w1: {
          worktreeId: 'w1',
          root: { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'src/a.ts' },
          focusedTerminalId: 'file:1'
        }
      }
    })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard' } })
    await waitFor(() => expect(labels()[0]).toBe('Discard File Changes…'))
    expect(call).toHaveBeenCalledWith('worktree.changes', { worktreeId: 'w1', path: 'src/a.ts', limit: 1 })
  })
})

describe('appearance from the palette', () => {
  const setAppearance = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    setAppearance.mockReset()
    seed({ setAppearance, systemTone: 'dark', appearance: { ...INITIAL.appearance, mode: 'dark' } })
  })

  it('switches the mode', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'appearance light' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(setAppearance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'light' }))
  })

  it('shows a preset of the other tone by switching to it', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'theme paper' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(setAppearance).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: 'light', light: expect.objectContaining({ themeId: 'paper' }) })
    )
  })
})

describe('the first screen', () => {
  const headers = (): string[] =>
    [...document.querySelectorAll('.palette__group')].map((header) => header.textContent ?? '')

  beforeEach(() => {
    seed({ worktrees: [worktree(), worktree({ id: 'w2', name: 'Fix the ruler', branch: 'fix-the-ruler' })] })
  })

  it('has no title over the field, and one ring-free field', () => {
    mount()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Go to' })).toBeTruthy()
  })

  it('groups worktrees, the one on screen under its name, then commands', () => {
    mount()
    expect(headers()).toEqual(['Worktrees', 'Rewrite the pager', 'Commands'])
    expect(labels().slice(0, 2)).toEqual(['Fix the ruler', 'Rewrite the pager'])
    expect(trailingOf('Rewrite the pager')).toBe('pager · current')
    expect(trailingOf('Copy Path')).toBe('')
    expect(trailingOf('New Task')).toBe('⌘N')
  })

  it('leads with a command once it has been run from here, after a reopen too', () => {
    const { unmount } = render(<CommandPalette modifier={MAC} mode="all" />)
    fireEvent.click(row('Show Files'))
    unmount()

    mount()
    expect(headers()[0]).toBe('Recent')
    expect(labels()[0]).toBe('Show Files')
    expect(labels().filter((label) => label === 'Show Files')).toHaveLength(1)
  })

  it('collapses to one ranked list once something is typed', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'copy' } })
    expect(headers()).toEqual([])
    expect(labels()).toEqual(['Copy Path', 'Copy Branch'])
  })
})
