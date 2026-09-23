/** @vitest-environment jsdom */

// One worktree on the sidebar, in each of the three shapes it has.
//
// A worktree is a background job, and the row is the only place its progress
// and its failures are ever reported — submitting the composer closes it and
// says nothing more. So the states this file is mostly about are the two a
// happy path never reaches: a checkout still being made, where the row must not
// pretend it can be opened, and one that failed, where the reason has to be on
// the row in words with the way out beside it.
//
// The other half is attention. `docs/teamwork.md` argues a project where
// anyone can type is survivable because nothing can be done invisibly, and this
// row is where a pane somebody else is reading or typing into says so.

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
  onOpenInEditor: vi.fn()
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

  // The row is the only place a failed creation is ever reported, so it can
  // still be removed — from the menu, which a row in any state has.
  it('can always be removed, whatever state it is in', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })
})

describe('a worktree that failed to be made', () => {
  it('gives the runtime’s own reason, on the row, with the way out beside it', () => {
    const reason = 'fatal: invalid reference: origin/nope'
    mount({ worktree: worktree({ state: 'failed', error: reason }) })
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })

  // A failure with no message is still a failure, and a blank row would read as
  // a rendering fault rather than as a job that did not finish.
  it('says something even when nothing said why', () => {
    mount({ worktree: worktree({ state: 'failed' }) })
    expect(screen.getByText('Creation failed.')).toBeTruthy()
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

  // "Could not read" and "nothing wrong" look the same at a glance and mean
  // opposite things, so the row has to say which it is — and how old.
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
    const row = screen.getByRole('button', { name: /claude/ })
    expect(within(row).getByText('running tests')).toBeTruthy()
    expect(within(row).getByText('1m')).toBeTruthy()
    row.click()
    expect(handlers.onFocusTerminal).toHaveBeenCalledExactlyOnceWith('t1')
  })

  // An empty quotation reads as an answer — "the pane printed nothing" and
  // "teamree has nothing to quote" are different facts.
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

  // Somebody running commands as you outranks somebody reading, in the one slot
  // the row has.
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

  // Liveness is computed, never stored: somebody who stopped an hour ago must
  // not still be announced as at the keyboard.
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

  // The record outlives the keystroke: a pane a teammate typed in an hour ago
  // is not a pane whose history is the owner's alone.
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
    const title = screen.getByRole('button', { name: /claude/ }).getAttribute('title') ?? ''
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

// One menu, three ways in, and the destructive item at the bottom of it rather
// than on the row.
//
// What this replaces is the whole point of it: the row's only control was a `×`
// that removed the checkout, so the most destructive action in the app was the
// easiest thing on the row to hit by accident — and reveal, copy and open were
// not reachable from the sidebar at all.
describe('the row menu', () => {
  it('opens on a right-click, with the five things a row can do, in order', () => {
    mount()
    fireEvent.contextMenu(row())

    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()
    expect(labels()).toEqual(['Reveal in Finder', 'Copy path', 'Copy branch', 'Open in Zed', 'Remove'])
  })

  // The heart of the change. A one-pixel miss on a `×` used to open the
  // question that destroys a checkout; now nothing on the row does.
  it('leaves no remove control on the row itself', () => {
    mount()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove worktree Rewrite the pager' })).toBeNull()
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })

  it('names the editor this project would use', () => {
    mount({ editorLabel: 'VS Code' })
    fireEvent.contextMenu(row())
    expect(labels()[3]).toBe('Open in VS Code')
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

// A menu reachable only with a mouse is a row that lost its only control to
// anybody who does not use one, which is what taking the `×` off would have
// meant without this.
describe('the row menu from the keyboard', () => {
  it('opens on the context-menu key and on Shift+F10, with the first item focused', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Reveal in Finder')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.keyDown(row(), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('walks the items with the arrows and chooses with Enter', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })

    const menu = screen.getByRole('menu')
    for (let press = 0; press < 4; press += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Remove')

    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(handlers.onRemove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // Wrapping, so the destructive item is one press away from the top in the
  // direction nobody reaches it by accident.
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

// Which panes have said something since this person last read them. The row is
// where the question is answered for a worktree that is not the one on screen,
// which is the whole of the gap: the sidebar used to read identically whether a
// worktree had been triaged a second ago or yesterday.
describe('panes that have printed since they were read', () => {
  it('marks the pane, and the worktree above it', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })], unread: ['t1'] })

    const pane = screen.getByRole('button', { name: /claude/ })
    expect(pane.className).toContain('pane-row--unread')
    expect(pane.title).toContain('unread')
    expect(screen.getByText('Rewrite the pager').className).toContain('worktree__name--unread')
  })

  it('says nothing about a pane nothing has arrived in since', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })] })

    expect(screen.getByRole('button', { name: /claude/ }).className).not.toContain('pane-row--unread')
    expect(screen.getByText('Rewrite the pager').className).not.toContain('worktree__name--unread')
  })
})
