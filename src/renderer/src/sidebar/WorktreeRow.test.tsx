/** @vitest-environment jsdom */

// One worktree on the sidebar, in each of its shapes. The row is the only place a checkout's
// progress and failures are reported, and where a pane somebody else is reading or typing into says so.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneWatcher, Terminal, Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import type { PaneAttention } from '../state/paneAttention'

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
const { WorktreeRow } = await import('./WorktreeRow')

const NOW = 1_700_000_000_000

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite-the-pager',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: NOW - 60_000,
  ...overrides
})

const terminal = (overrides: Partial<Terminal> = {}): Terminal => ({
  id: 't1',
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/repos/pager-wt/rewrite-the-pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: NOW,
  ...overrides
})

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: NOW,
  ...overrides
})

const watcher = (handle: string): PaneWatcher => ({ handle, publicKey: `${handle}-key`, since: NOW - 1_000 })

const handlers = {
  onOpen: vi.fn(),
  onRetry: vi.fn(),
  onRemove: vi.fn(),
  onFocusTerminal: vi.fn(),
  onReveal: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyBranch: vi.fn(),
  onOpenInEditor: vi.fn(),
  onRename: vi.fn()
}

function mount(
  overrides: {
    worktree?: Worktree
    status?: WorktreeStatus
    mergePreview?: WorktreeMergePreview
    terminals?: Terminal[]
    evidence?: Record<string, string | null>
    watchers?: Record<string, PaneAttention>
    unread?: Iterable<string>
    active?: boolean
    editorLabel?: string
  } = {}
): void {
  render(
    <ul>
      <WorktreeRow
        worktree={overrides.worktree ?? worktree()}
        status={overrides.status}
        mergePreview={overrides.mergePreview}
        terminals={overrides.terminals ?? []}
        evidence={overrides.evidence ?? {}}
        watchers={overrides.watchers ?? {}}
        unread={new Set(overrides.unread ?? [])}
        now={NOW}
        active={overrides.active ?? false}
        editorLabel={overrides.editorLabel ?? 'Zed'}
        {...handlers}
      />
    </ul>
  )
}

// Anchored: the `⋯` is named "More for Rewrite the pager".
const openButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Rewrite the pager/ })
const row = (): HTMLElement => document.querySelector('.worktree') as HTMLElement
const labels = (): string[] => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')

beforeEach(() => {
  useWorkspaceStore.setState({ unreadableSince: {} })
  for (const handler of Object.values(handlers)) handler.mockReset()
})

// The fourth shape: the checkout deleted from disk with git none the wiser, and the row saying `ready`.
describe('a worktree whose directory is gone', () => {
  it('says so, dimmed, and cannot be opened', () => {
    mount({ worktree: worktree({ missing: true }) })
    expect(screen.getByText('missing')).toBeTruthy()
    expect(row().classList.contains('worktree--missing')).toBe(true)
    expect(openButton().disabled).toBe(true)
  })

  it('says nothing about git, and shows no panes, for a checkout that is not there', () => {
    mount({
      worktree: worktree({ missing: true }),
      status: status({ untracked: 3, missing: true }),
      terminals: [terminal()]
    })
    expect(screen.queryByLabelText(/git status/)).toBeNull()
    expect(document.querySelector('.pane-row')).toBeNull()
  })

  it('offers only removal', () => {
    mount({ worktree: worktree({ missing: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'More for Rewrite the pager' }))
    expect(labels()).toEqual(['Remove'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })
})

describe('a worktree still being made', () => {
  it('says so, and cannot be opened while it is not there', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    expect(screen.getByText('creating')).toBeTruthy()
    expect(openButton().disabled).toBe(true)
    openButton().click()
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it('shows progress a reader can name, rather than an unlabelled bar', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    expect(screen.getByRole('progressbar', { name: 'Creating Rewrite the pager' })).toBeTruthy()
  })

  it('says nothing about git for a checkout that does not exist yet', () => {
    mount({ worktree: worktree({ state: 'creating' }), status: status({ untracked: 3 }) })
    expect(screen.queryByLabelText(/git status/)).toBeNull()
  })

  // The row is the only place a failed creation is reported, so it can always be removed.
  it('can always be removed, whatever state it is in', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })
})

describe('a worktree that failed to be made', () => {
  const failure = (): HTMLElement => document.querySelector('.worktree__error') as HTMLElement

  it('says why in one short line, with git’s whole message on hover', () => {
    const reason =
      'git worktree add --no-track -b doomed /repos/pager-wt/doomed 1a2b3c exited with code 128: fatal: invalid reference: origin/nope\nhint: six more lines\nhint: of advice'
    mount({ worktree: worktree({ state: 'failed', error: reason }) })
    expect(failure().textContent).toBe('Invalid reference: origin/nope')
    expect(failure().title).toBe(reason)
    expect(screen.getByText('failed')).toBeTruthy()
  })

  it('cuts a long reason to about sixty characters', () => {
    const reason = `start point "${'x'.repeat(80)}" is not a ref in this repository`
    mount({ worktree: worktree({ state: 'failed', error: reason }) })
    expect(failure().textContent?.length).toBeLessThanOrEqual(60)
    expect(failure().textContent?.endsWith('…')).toBe(true)
    expect(failure().title).toBe(reason)
  })

  it('offers Retry only when trying again could work', () => {
    mount({ worktree: worktree({ state: 'failed', error: 'creation cancelled', retryable: true }) })
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })

  it('offers no Retry for a cause that will not pass', () => {
    mount({ worktree: worktree({ state: 'failed', error: 'fatal: invalid reference: origin/nope' }) })
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('always offers Remove beside the reason', () => {
    mount({ worktree: worktree({ state: 'failed', error: 'no' }) })
    screen.getByRole('button', { name: 'Remove' }).click()
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })

  // A blank row would read as a rendering fault rather than a job that did not finish.
  it('says something even when nothing said why', () => {
    mount({ worktree: worktree({ state: 'failed' }) })
    expect(screen.getByText('Creation failed')).toBeTruthy()
  })

  it('cannot be opened, because there is nothing to open', () => {
    mount({ worktree: worktree({ state: 'failed', error: 'no' }) })
    expect(openButton().disabled).toBe(true)
  })
})

describe('a worktree that is ready', () => {
  it('opens on a press, and says which one the workspace is showing', () => {
    mount({ active: true })
    expect(openButton().getAttribute('aria-current')).toBe('true')
    openButton().click()
    expect(handlers.onOpen).toHaveBeenCalledOnce()
  })

  it('does not claim to be current when it is not', () => {
    mount()
    expect(openButton().getAttribute('aria-current')).toBeNull()
  })

  it('names its branch as well as its task', () => {
    mount()
    expect(within(openButton()).getByText('rewrite-the-pager')).toBeTruthy()
  })

  it('reads git out in words, not only as coloured chips', () => {
    mount({ status: status({ ahead: 2, unstaged: 3 }) })
    const chips = screen.getByLabelText(/^git status:/)
    expect(chips.getAttribute('aria-label')).toContain('2 ahead')
    expect(chips.textContent).toContain('2')
    expect(chips.textContent).toContain('3')
  })

  // "Could not read" and "nothing wrong" look the same at a glance and mean opposite things.
  it('admits when the numbers on it could not be confirmed', () => {
    // The chips read the wall clock themselves, so this one is stated against it.
    useWorkspaceStore.setState({ unreadableSince: { w1: Date.now() - 120_000 } })
    mount({ status: status({ ahead: 1, readAt: Date.now() - 120_000 }) })
    expect(screen.getByLabelText(/^git status:/).getAttribute('aria-label')).toContain('Could not read this worktree')
  })

  it('says whether the branch would merge, and why, without saying "merged"', () => {
    mount({
      mergePreview: {
        worktreeId: 'w1',
        baseRef: 'origin/main',
        state: 'conflicts',
        ahead: 2,
        conflicts: ['src/pager.ts', 'src/index.ts'],
        readAt: NOW
      } as WorktreeMergePreview
    })
    const badge = screen.getByText('2 conflicts')
    expect(badge.getAttribute('title')).toContain('src/pager.ts')
  })
})

describe('what the panes under it are doing', () => {
  it('lists each pane with what it last printed, and focuses it on a press', () => {
    mount({
      terminals: [terminal({ id: 't1', agent: 'claude', lastOutputAt: NOW - 90_000 })],
      evidence: { t1: 'running tests' }
    })
    const row = screen.getByRole('button', { name: /Claude Code/ })
    expect(within(row).getByText('running tests')).toBeTruthy()
    expect(within(row).getByText('1m')).toBeTruthy()
    row.click()
    expect(handlers.onFocusTerminal).toHaveBeenCalledExactlyOnceWith('t1')
  })

  // "The pane printed nothing" and "teamree has nothing to quote" are different facts.
  it('quotes nothing at all when there is nothing worth quoting', () => {
    mount({ terminals: [terminal({ id: 't1' })], evidence: { t1: null } })
    expect(document.querySelector('.pane-row__evidence')).toBeNull()
  })

  it('says who is reading a pane by name, never as a count', () => {
    mount({
      terminals: [terminal({ id: 't1' })],
      watchers: { t1: { watchers: [watcher('ana'), watcher('bo')], typists: [], muted: false } }
    })
    expect(screen.getByText('ana and bo are watching')).toBeTruthy()
  })

  // Typing outranks reading in the one slot the row has.
  it('says who is typing, in the present tense, over who is merely watching', () => {
    mount({
      terminals: [terminal({ id: 't1' })],
      watchers: {
        t1: {
          watchers: [watcher('ana')],
          typists: [
            { handle: 'bo', publicKey: 'bo-key', since: NOW - 9_000, at: NOW - 500, writes: 12, bytes: 12, refused: 0 }
          ],
          muted: false
        }
      }
    })
    expect(screen.getByText('bo is typing')).toBeTruthy()
    expect(screen.queryByText(/watching/)).toBeNull()
  })

  // Liveness is computed, never stored.
  it('stops saying somebody is typing once they have stopped', () => {
    mount({
      terminals: [terminal({ id: 't1' })],
      watchers: {
        t1: {
          watchers: [watcher('ana')],
          typists: [
            {
              handle: 'bo',
              publicKey: 'bo-key',
              since: NOW - 3_700_000,
              at: NOW - 3_600_000,
              writes: 12,
              bytes: 12,
              refused: 0
            }
          ],
          muted: false
        }
      }
    })
    expect(screen.queryByText('bo is typing')).toBeNull()
    expect(screen.getByText('ana is watching')).toBeTruthy()
  })

  // The record outlives the keystroke.
  it('keeps the count of what was typed and what was refused, on hover', () => {
    mount({
      terminals: [terminal({ id: 't1' })],
      watchers: {
        t1: {
          watchers: [],
          typists: [
            {
              handle: 'bo',
              publicKey: 'bo-key',
              since: NOW - 3_700_000,
              at: NOW - 3_600_000,
              writes: 12,
              bytes: 12,
              refused: 4
            }
          ],
          muted: true
        }
      }
    })
    const title = screen.getByRole('button', { name: /zsh/ }).getAttribute('title') ?? ''
    expect(title).toContain('bo has typed 12 keystrokes here')
    expect(title).toContain('bo tried 4 this machine refused')
    expect(title).toContain('muted')
  })

  it('says a pane is muted wherever it is listed, because mute is the owner’s', () => {
    mount({
      terminals: [terminal({ id: 't1' })],
      watchers: { t1: { watchers: [], typists: [], muted: true } }
    })
    expect(screen.getByText('muted')).toBeTruthy()
  })

  it('says where a quoted line came from, so it never reads as a verdict', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })], evidence: { t1: '3 tests failed' } })
    const title = screen.getByRole('button', { name: /Claude Code/ }).getAttribute('title') ?? ''
    expect(title).toContain('last printed: 3 tests failed')
  })

  it('sums the panes into one state for the row, with a failure outranking work', () => {
    mount({
      terminals: [
        terminal({ id: 't1', busy: true }),
        terminal({ id: 't2', running: false, exitCode: 1 }),
        terminal({ id: 't3', worktreeId: 'other' })
      ]
    })
    expect(screen.getByLabelText('exited with an error')).toBeTruthy()
  })

  it('leaves out panes belonging to another worktree', () => {
    mount({ terminals: [terminal({ id: 't9', worktreeId: 'other', title: 'elsewhere' })] })
    expect(screen.queryByText('elsewhere')).toBeNull()
  })

  it('lists no panes at all for a worktree still being made', () => {
    mount({ worktree: worktree({ state: 'creating' }), terminals: [terminal({ id: 't1' })] })
    expect(screen.queryByRole('button', { name: /zsh/ })).toBeNull()
  })
})

// One menu, three ways in, and the destructive item at the bottom of it rather than on the row,
// where a `×` was the easiest thing to hit by accident.
describe('the row menu', () => {
  it('opens on a right-click, with the six things a row can do, in order', () => {
    mount()
    fireEvent.contextMenu(row())

    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()
    expect(labels()).toEqual(['Rename…', 'Reveal in Finder', 'Copy path', 'Copy branch', 'Open in Zed', 'Remove'])
  })

  // A one-pixel miss on the row must not open the question that destroys a checkout.
  it('leaves no remove control on the row itself', () => {
    mount()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove worktree Rewrite the pager' })).toBeNull()
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })

  it('names the editor this project would use', () => {
    mount({ editorLabel: 'VS Code' })
    fireEvent.contextMenu(row())
    expect(labels()[4]).toBe('Open in VS Code')
  })

  it('opens the same menu from the ⋯ beside the row', () => {
    mount()
    const more = screen.getByRole('button', { name: 'More for Rewrite the pager' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })

  it('chooses the item that was pressed, and closes behind it', () => {
    mount()
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))

    expect(handlers.onCopyPath).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reveals and copies the branch from the same menu', () => {
    mount()
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy branch' }))
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Zed' }))

    expect(handlers.onReveal).toHaveBeenCalledOnce()
    expect(handlers.onCopyBranch).toHaveBeenCalledOnce()
    expect(handlers.onOpenInEditor).toHaveBeenCalledOnce()
  })
})

// A menu reachable only with a mouse is a row with no control for anybody who does not use one.
describe('the row menu from the keyboard', () => {
  it('opens on the context-menu key and on Shift+F10, with the first item focused', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Rename…')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.keyDown(row(), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('walks the items with the arrows and chooses with Enter', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })

    const menu = screen.getByRole('menu')
    for (let press = 0; press < 5; press += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Remove')

    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(handlers.onRemove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // Wrapping, so the destructive item is one press from the top in the direction nobody reaches by accident.
  it('wraps upwards from the first item', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })

    expect(document.activeElement?.textContent).toBe('Remove')
  })

  it('closes on Escape and gives the row back the focus', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(openButton())
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })
})

// The name typed in the composer is a first draft; the winner of a race deserves a better one.
describe('renaming', () => {
  const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Worktree name' })

  it('edits the name in place from the menu, and commits on Return', () => {
    mount()
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))

    expect(document.activeElement).toBe(field())
    expect(field().value).toBe('Rewrite the pager')
    fireEvent.change(field(), { target: { value: '  pager, the winner ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })

    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith('pager, the winner')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(openButton())
  })

  it('edits on a double-click of the name', () => {
    mount()
    fireEvent.doubleClick(screen.getByText('Rewrite the pager'))
    expect(field().value).toBe('Rewrite the pager')
  })

  it('edits on Return at a focused row instead of opening it', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(openButton(), { key: 'Enter' })

    expect(document.activeElement).toBe(field())
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it('still opens from the keyboard on Space and ⌘↓, as a Finder row does', () => {
    mount()
    fireEvent.keyDown(openButton(), { key: ' ' })
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.keyDown(openButton(), { key: 'ArrowDown', metaKey: true })
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('puts the old name back on Escape', () => {
    mount()
    fireEvent.doubleClick(screen.getByText('Rewrite the pager'))
    fireEvent.change(field(), { target: { value: 'something else' } })
    fireEvent.keyDown(field(), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Rewrite the pager')).toBeTruthy()
    expect(handlers.onRename).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(openButton())
  })

  it('refuses an empty name and keeps editing', () => {
    mount()
    fireEvent.doubleClick(screen.getByText('Rewrite the pager'))
    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })

    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(handlers.onRename).not.toHaveBeenCalled()

    fireEvent.blur(field())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(handlers.onRename).not.toHaveBeenCalled()
  })

  it('commits on blur, once, and says nothing for an unchanged name', () => {
    mount()
    fireEvent.doubleClick(screen.getByText('Rewrite the pager'))
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(handlers.onRename).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('Rewrite the pager'))
    fireEvent.change(field(), { target: { value: 'renamed' } })
    fireEvent.blur(field())
    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith('renamed')
  })
})

// The row is where "unread" is answered for a worktree that is not the one on screen.
describe('panes that have printed since they were read', () => {
  it('marks the pane, and the worktree above it', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })], unread: ['t1'] })

    const pane = screen.getByRole('button', { name: /Claude Code/ })
    expect(pane.className).toContain('pane-row--unread')
    expect(pane.title).toContain('unread')
    expect(screen.getByText('Rewrite the pager').className).toContain('worktree__name--unread')
    // One dot on each row, ringed, and no second mark beside it.
    expect(document.querySelectorAll('.pip')).toHaveLength(0)
    const dots = document.querySelectorAll('.activity')
    expect(dots).toHaveLength(2)
    for (const dot of dots) expect(dot.classList.contains('activity--unread')).toBe(true)
  })

  it('says nothing about a pane nothing has arrived in since', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })] })

    expect(screen.getByRole('button', { name: /Claude Code/ }).className).not.toContain('pane-row--unread')
    expect(screen.getByText('Rewrite the pager').className).not.toContain('worktree__name--unread')
  })
})
