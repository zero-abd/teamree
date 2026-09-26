/** @vitest-environment jsdom */

// One worktree on the sidebar, in each of its shapes. The row is the only place a checkout's
// progress and failures are reported, and where a pane somebody else is reading or typing into says so.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PaneWatcher,
  Terminal,
  Worktree,
  WorktreeLanding,
  WorktreeMergePreview,
  WorktreeStatus
} from '@shared/entities'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { pressWorktreeRow, worktreeRowIsOpen } from '../../../../scripts/smoke-probes.mjs'
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
  onForget: vi.fn(),
  onFocusTerminal: vi.fn(),
  onReveal: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyBranch: vi.fn(),
  onRename: vi.fn()
}

const openInZed = vi.fn()
const openInFinder = vi.fn()

function mount(
  overrides: {
    worktree?: Worktree
    status?: WorktreeStatus
    mergePreview?: WorktreeMergePreview
    landing?: WorktreeLanding
    onKeep?: () => void
    terminals?: Terminal[]
    evidence?: Record<string, string | null>
    watchers?: Record<string, PaneAttention>
    unread?: Iterable<string>
    active?: boolean
    openIn?: { label: string; onChoose: () => void }[]
    twinRun?: boolean
  } = {}
): void {
  render(
    <ul>
      <WorktreeRow
        worktree={overrides.worktree ?? worktree()}
        status={overrides.status}
        mergePreview={overrides.mergePreview}
        {...(overrides.landing === undefined ? {} : { landing: overrides.landing })}
        {...(overrides.onKeep === undefined ? {} : { onKeep: overrides.onKeep })}
        terminals={overrides.terminals ?? []}
        evidence={overrides.evidence ?? {}}
        watchers={overrides.watchers ?? {}}
        unread={new Set(overrides.unread ?? [])}
        now={NOW}
        active={overrides.active ?? false}
        {...(overrides.twinRun === undefined ? {} : { twinRun: overrides.twinRun })}
        openIn={
          overrides.openIn ?? [
            { label: 'Zed', onChoose: openInZed },
            { label: 'Finder', onChoose: openInFinder }
          ]
        }
        {...handlers}
      />
    </ul>
  )
}

// Anchored: the `⋯` is named "More for Rewrite the pager".
const openButton = (): HTMLButtonElement => screen.getByRole('treeitem', { name: /^Rewrite the pager/ })
const row = (): HTMLElement => document.querySelector('.worktree') as HTMLElement
const labels = (): string[] => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')

beforeEach(() => {
  useWorkspaceStore.setState({ unreadableSince: {} })
  for (const handler of [...Object.values(handlers), openInZed, openInFinder]) handler.mockReset()
})

// The fourth shape: the checkout deleted from disk with git none the wiser, and the row saying `ready`.
describe('a worktree whose directory is gone', () => {
  it('says so, dimmed, and cannot be opened', () => {
    mount({ worktree: worktree({ missing: true }) })
    expect(screen.getByText('missing')).toBeTruthy()
    expect(row().classList.contains('worktree--missing')).toBe(true)
    expect(openButton().getAttribute('aria-disabled')).toBe('true')
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
    expect(labels()).toEqual(['Remove from teamree', 'Delete Worktree…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Worktree…' }))
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })
})

describe('a worktree still being made', () => {
  it('says so, and cannot be opened while it is not there', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    expect(screen.getByText('creating')).toBeTruthy()
    expect(openButton().getAttribute('aria-disabled')).toBe('true')
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Worktree…' }))
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })
})

// The release smoke presses rows with these; pressing one still being created opened nothing.
describe('the smoke probes', () => {
  const inWindow = (code: string): unknown => new Function(`return ${code}`)()

  it('wait for a row being created instead of pressing it', () => {
    mount({ worktree: worktree({ state: 'creating' }) })
    expect(inWindow(pressWorktreeRow('Rewrite the pager'))).toBe(false)
  })

  it('press a ready row and see it open', () => {
    mount()
    expect(inWindow(pressWorktreeRow('Rewrite the pager'))).toBe(true)
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    expect(inWindow(worktreeRowIsOpen('Rewrite the pager'))).toBe(false)
    cleanup()
    mount({ active: true })
    expect(inWindow(worktreeRowIsOpen('Rewrite the pager'))).toBe(true)
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
    expect(openButton().getAttribute('aria-disabled')).toBe('true')
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
    mount({ worktree: worktree({ branch: 'ada/pager' }) })
    expect(within(openButton()).getByText('ada/pager')).toBeTruthy()
  })

  // `scratch / scratch`: a branch that is only the name slugified says it twice.
  it('leaves out a branch that is only its name slugified', () => {
    mount()
    expect(within(openButton()).queryByText('rewrite-the-pager')).toBeNull()
  })

  // A chip alone on a second line reads as loose; with no branch there is no second line.
  it('keeps its chips on the first line, just left of the dot, when the branch is left out', () => {
    mount({ status: status({ unstaged: 1 }), terminals: [terminal({ agent: 'claude' })] })
    expect(document.querySelector('.worktree__meta')).toBeNull()
    const head = document.querySelector('.worktree__title') as HTMLElement
    const chips = head.querySelector('.gitchips') as HTMLElement
    expect(chips).not.toBeNull()
    const end = head.lastElementChild as HTMLElement
    expect(chips.closest('.worktree__facts')?.nextElementSibling).toBe(end.lastElementChild)
    expect(end.lastElementChild?.classList.contains('activity')).toBe(true)
  })

  it('says a child is behind its parent, not behind main', () => {
    mount({ worktree: worktree({ parentId: 'w0', baseRef: 'rework-auth' }), status: status({ behind: 2 }) })
    const chips = document.querySelector('.gitchips') as HTMLElement
    expect(chips.textContent).toBe('2 behind parent')
    expect(chips.getAttribute('aria-label')).toBe('git status: 2 behind parent')
  })

  it('keeps its chips beside the branch when the branch says more', () => {
    mount({ worktree: worktree({ branch: 'ada/pager' }), status: status({ unstaged: 1 }) })
    const meta = document.querySelector('.worktree__meta') as HTMLElement
    expect(within(meta).getByText('ada/pager')).toBeTruthy()
    expect(meta.querySelector('.gitchips')).not.toBeNull()
    expect(document.querySelector('.worktree__title .gitchips')).toBeNull()
  })

  it('draws a clean merge as a mark, with the sentence on hover', () => {
    mount({
      mergePreview: {
        worktreeId: 'w1',
        baseRef: 'origin/main',
        state: 'clean',
        ahead: 2,
        conflicts: [],
        readAt: NOW
      } as WorktreeMergePreview
    })
    expect(screen.queryByText('merges')).toBeNull()
    const mark = screen.getByRole('img', { name: '2 commits merge cleanly into origin/main' })
    expect(mark.getAttribute('title')).toBe('2 commits merge cleanly into origin/main')
  })

  // A dot beside the activity dot read as a second status.
  it('counts uncommitted changes as text, with no dot', () => {
    mount({ status: status({ unstaged: 1 }) })
    const chips = screen.getByLabelText(/^git status:/)
    expect(chips.textContent).toBe('Δ1')
    expect(chips.querySelector('.gitchip__bullet')).toBeNull()
  })

  // The open worktree has the status bar and the Changes badge; CSS shows these on hover.
  it('keeps the git counts and the merge mark in one group the open row can hide', () => {
    mount({
      active: true,
      status: status({ unstaged: 1 }),
      mergePreview: {
        worktreeId: 'w1',
        baseRef: 'origin/main',
        state: 'clean',
        ahead: 1,
        conflicts: [],
        readAt: NOW
      } as WorktreeMergePreview
    })
    const git = document.querySelector('.worktree__git') as HTMLElement
    expect(git.querySelector('.gitchips')).not.toBeNull()
    expect(git.querySelector('.worktree__merge')).not.toBeNull()
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
    // A mark like the clean one, not a word: the count and paths are on hover.
    expect(screen.queryByText('2 conflicts')).toBeNull()
    const mark = screen.getByRole('img', { name: /^Would conflict with origin\/main/ })
    expect(mark.getAttribute('title')).toContain('src/pager.ts')
    expect(mark.className).toContain('worktree__merge--conflicts')
    expect(mark.querySelector('svg')).not.toBeNull()
  })
})

describe('one of several runs of a task', () => {
  const TASK = 'Add a subtract function to src/math.ts'
  const codexRun = (): Worktree =>
    worktree({ name: 'Add a subtract function to codex', branch: 'add-a-subtract-function-to-codex', task: TASK })

  it('leads with its agent’s glyph, ahead of the task', () => {
    mount({ worktree: codexRun() })
    const head = document.querySelector('.worktree__title') as HTMLElement
    const slot = head.firstElementChild as HTMLElement
    expect(slot.className).toBe('worktree__agent')
    expect(slot.querySelector('[data-agent="codex"]')).not.toBeNull()
    expect(slot.textContent).toBe('')
    expect(head.querySelector('.worktree__name')?.textContent).toBe(TASK)
  })

  // The stored name is cut to "Add a subtract function to", which read aloud as a dangling "to".
  it('reads the whole task line, then its agent in words, and hovers the same name', () => {
    mount({ worktree: codexRun() })
    expect(screen.getByRole('treeitem', { name: `${TASK} (Codex)` })).toBeTruthy()
    expect(document.querySelector('.worktree__name')?.getAttribute('title')).toBe(`${TASK} (Codex)`)
    expect(screen.getByRole('button', { name: `More for ${TASK} (Codex)` })).toBeTruthy()
    expect(document.body.innerHTML).not.toMatch(/codex ·|claude ·/u)
    expect(document.querySelector('.worktree__branch')).toBeNull()
  })

  // Name first, then what state it is in: glued together, "claudeAdd a subtract…stopped" is one word.
  it('is named task, then agent, and described by its state and changes', () => {
    mount({
      worktree: worktree({
        name: 'Add a subtract function to calc claude',
        branch: 'add-a-subtract-function-to-calc-claude',
        task: 'Add a subtract function to calc'
      }),
      terminals: [terminal({ agent: 'claude', lastOutputAt: NOW - 90_000 })],
      status: status({ unstaged: 1 })
    })
    const button = screen.getByRole('treeitem', { name: 'Add a subtract function to calc (Claude Code)' })
    expect(button.classList.contains('worktree__open')).toBe(true)
    expect(
      button
        .getAttribute('aria-describedby')
        ?.split(' ')
        .map((id) => document.getElementById(id))
    ).toEqual([screen.getByRole('img', { name: 'stopped' }), document.querySelector('.worktree__facts')])
    expect(
      within(document.querySelector('.worktree__facts') as HTMLElement)
        .getByRole('img')
        .getAttribute('aria-label')
    ).toBe('git status: 1 uncommitted')
  })

  // The pane row under it starts with the same glyph; the word only costs the title width.
  it('draws the glyph alone while one agent pane runs in it', () => {
    mount({ worktree: codexRun(), terminals: [terminal({ id: 't1', agent: 'codex' }), terminal({ id: 't2' })] })
    const slot = document.querySelector('.worktree__agent') as HTMLElement
    expect(slot.querySelector('[data-agent="codex"]')).not.toBeNull()
    expect(slot.textContent).toBe('')
    expect(screen.getByRole('treeitem', { name: `${TASK} (Codex)` })).toBeTruthy()
  })

  it('names the agent in words only beside a sibling run of the same agent', () => {
    mount({
      worktree: codexRun(),
      terminals: [terminal({ id: 't1', agent: 'codex' }), terminal({ id: 't2', agent: 'codex' })]
    })
    mount({ worktree: codexRun(), terminals: [terminal({ id: 't1', agent: 'codex' })], twinRun: true })
    expect([...document.querySelectorAll('.worktree__agent')].map((slot) => slot.textContent)).toEqual(['', 'Codex'])
  })

  // Closed, then started again from the empty worktree: the second codex this worktree has seen.
  it('draws a restarted task agent as the task’s pane, not as a number', () => {
    mount({ worktree: codexRun(), terminals: [terminal({ id: 't1', agent: 'codex', ordinal: 2 })] })
    const pane = document.querySelector('.pane-row') as HTMLElement
    expect(pane.querySelector('.pane-row__label')).toBeNull()
    expect(pane.textContent).not.toMatch(/\b2\b/u)
  })

  // The task pane is named after the worktree; saying it again under the row is noise.
  it('draws the pane named after it as its glyph and last line alone', () => {
    mount({
      worktree: codexRun(),
      terminals: [terminal({ id: 't1', agent: 'codex', label: 'Add a subtract function to codex' })],
      evidence: { t1: 'Edited calc.js (+1 -0)' }
    })
    const pane = document.querySelector('.pane-row') as HTMLElement
    expect(within(pane).getByRole('img', { name: 'Codex' })).toBeTruthy()
    expect(pane.querySelector('.pane-row__label')).toBeNull()
    expect(pane.querySelector('.pane-row__head')?.textContent).toContain('Edited calc.js (+1 -0)')
  })
})

describe('what the panes under it are doing', () => {
  // The sidebar draws the worktree as one box; the box is this element.
  it('holds its row and its panes in one box', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' }), terminal({ id: 't2' })] })
    const box = row()
    expect(box.querySelector(':scope > .worktree__row')).toBeTruthy()
    expect(box.querySelectorAll(':scope > .panes .pane-row')).toHaveLength(2)
  })

  it('lists each pane with what it last printed, and focuses it on a press', () => {
    mount({
      terminals: [terminal({ id: 't1', agent: 'claude', lastOutputAt: NOW - 90_000 })],
      evidence: { t1: 'running tests' }
    })
    const row = screen.getByRole('treeitem', { name: /Claude Code/ })
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
    const title = screen.getByRole('treeitem', { name: /zsh/ }).getAttribute('title') ?? ''
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
    const title = screen.getByRole('treeitem', { name: /Claude Code/ }).getAttribute('title') ?? ''
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
    expect(screen.getByLabelText('failed')).toBeTruthy()
  })

  it('leaves out panes belonging to another worktree', () => {
    mount({ terminals: [terminal({ id: 't9', worktreeId: 'other', title: 'elsewhere' })] })
    expect(screen.queryByText('elsewhere')).toBeNull()
  })

  it('lists no panes at all for a worktree still being made', () => {
    mount({ worktree: worktree({ state: 'creating' }), terminals: [terminal({ id: 't1' })] })
    expect(screen.queryByRole('treeitem', { name: /zsh/ })).toBeNull()
  })
})

// One menu, three ways in, and the destructive item at the bottom of it rather than on the row,
// where a `×` was the easiest thing to hit by accident.
describe('the row menu', () => {
  it('opens on a right-click, with the six things a row can do, in order', () => {
    mount()
    fireEvent.contextMenu(row())

    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()
    expect(labels()).toEqual([
      'Rename…',
      'Reveal in Finder',
      'Copy Path',
      'Copy Branch',
      'Open in',
      'Remove from teamree',
      'Delete Worktree…'
    ])
  })

  it('forgets on Remove from teamree, apart from Delete Worktree…', () => {
    mount()
    fireEvent.contextMenu(row())

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from teamree' }))
    expect(handlers.onForget).toHaveBeenCalledOnce()
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })

  // A one-pixel miss on the row must not open the question that destroys a checkout.
  it('leaves no remove control on the row itself', () => {
    mount()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove worktree Rewrite the pager' })).toBeNull()
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })

  it('offers the apps it was given under Open in, in the order given', () => {
    mount()
    fireEvent.contextMenu(row())
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Open in' }))

    const apps = screen.getByRole('menu', { name: 'Open in' })
    expect(
      within(apps)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Zed', 'Finder'])
    fireEvent.click(within(apps).getByRole('menuitem', { name: 'Finder' }))

    expect(openInFinder).toHaveBeenCalledOnce()
    expect(openInZed).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))

    expect(handlers.onCopyPath).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reveals and copies the branch from the same menu', () => {
    mount()
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Branch' }))

    expect(handlers.onReveal).toHaveBeenCalledOnce()
    expect(handlers.onCopyBranch).toHaveBeenCalledOnce()
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
    for (let press = 0; press < 6; press += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Delete Worktree…')

    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(handlers.onRemove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('goes into Open in with the right arrow and back out with the left', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })
    const menu = screen.getAllByRole('menu')[0] as HTMLElement
    for (let press = 0; press < 4; press += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Open in')
    expect(screen.getByRole('menuitem', { name: 'Open in' }).getAttribute('aria-haspopup')).toBe('menu')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(document.activeElement?.textContent).toBe('Zed')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement?.textContent).toBe('Open in')
    expect(screen.queryByRole('menu', { name: 'Open in' })).toBeNull()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    expect(openInFinder).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // Wrapping, so the destructive item is one press from the top in the direction nobody reaches by accident.
  it('wraps upwards from the first item', () => {
    mount()
    openButton().focus()
    fireEvent.keyDown(row(), { key: 'ContextMenu' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })

    expect(document.activeElement?.textContent).toBe('Delete Worktree…')
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

    const pane = screen.getByRole('treeitem', { name: /Claude Code/ })
    expect(pane.className).toContain('pane-row--unread')
    expect(pane.title).toContain('unread')
    expect(screen.getByText('Rewrite the pager').className).toContain('worktree__name--unread')
    // One dot, the worktree's, saying the state alone; unread is the names' weight.
    expect(document.querySelectorAll('.pip')).toHaveLength(0)
    const dots = document.querySelectorAll('.activity')
    expect(dots).toHaveLength(1)
    expect(dots[0]?.className).toBe('activity activity--quiet')
    expect(pane.querySelector('.activity')).toBeNull()
  })

  // In a still frame, or with reduced motion, finished-and-unread once drew the working violet.
  describe('drawn with the stylesheet', () => {
    const sheet = document.createElement('style')
    sheet.textContent = readFileSync(path.join(import.meta.dirname, '../styles/sidebar.css'), 'utf8')
    beforeAll(() => {
      document.head.append(sheet)
    })
    afterAll(() => {
      sheet.remove()
    })
    const dot = (): Element => document.querySelector('.activity') as Element

    it('draws a stopped, unread pane apart from a working one', () => {
      mount({ terminals: [terminal({ id: 't1', agent: 'claude' })], unread: ['t1'] })
      const stopped = { className: dot().className, background: getComputedStyle(dot()).background }
      cleanup()
      mount({ terminals: [terminal({ id: 't1', agent: 'claude', busy: true })] })
      const working = { className: dot().className, background: getComputedStyle(dot()).background }

      expect(stopped.className).not.toBe(working.className)
      expect(stopped.background).not.toBe(working.background)
      expect(working.background).toBe('var(--accent-bright)')
    })

    it('draws asking one way, read or unread', () => {
      const asking = terminal({ id: 't1', agent: 'claude', lastBellAt: NOW })
      mount({ terminals: [asking], unread: ['t1'] })
      const unread = getComputedStyle(dot())
      expect(dot().className).toBe('activity activity--waiting')
      expect(unread.outline).toBe('')
      expect(unread.background).toBe('var(--warning)')
    })
  })

  it('says nothing about a pane nothing has arrived in since', () => {
    mount({ terminals: [terminal({ id: 't1', agent: 'claude' })] })

    expect(screen.getByRole('treeitem', { name: /Claude Code/ }).className).not.toContain('pane-row--unread')
    expect(screen.getByText('Rewrite the pager').className).not.toContain('worktree__name--unread')
  })
})

// A row of the sidebar tree: its panes fold on ← and come back on →, and the tree's Tab stop moves by arrow.
describe('the row in the sidebar tree', () => {
  const paneRows = (): Element[] => [...document.querySelectorAll('.pane-row')]

  it('is a second-level tree item that says whether its panes are shown', () => {
    mount({ terminals: [terminal()] })
    expect(openButton().getAttribute('aria-level')).toBe('2')
    expect(openButton().getAttribute('aria-expanded')).toBe('true')
    expect(openButton().tabIndex).toBe(-1)
    expect(paneRows()[0]?.getAttribute('role')).toBe('treeitem')
    expect(paneRows()[0]?.getAttribute('aria-level')).toBe('3')
  })

  it('folds its panes on ← and unfolds them on →', () => {
    mount({ terminals: [terminal()] })
    fireEvent.keyDown(openButton(), { key: 'ArrowLeft' })
    expect(paneRows()).toHaveLength(0)
    expect(openButton().getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(openButton(), { key: 'ArrowRight' })
    expect(paneRows()).toHaveLength(1)
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it('claims no fold for a row with no panes', () => {
    mount()
    expect(openButton().hasAttribute('aria-expanded')).toBe(false)
  })

  it('leaves the ⋯ to the mouse and the menu key, off the Tab order', () => {
    mount()
    expect(screen.getByRole('button', { name: 'More for Rewrite the pager' }).tabIndex).toBe(-1)
  })

  // Focusable, so the arrows reach it and its menu, but pressing it does nothing.
  it('stays in reach while it cannot be opened, and offers Retry from its menu', () => {
    mount({ worktree: worktree({ state: 'failed', error: 'creation cancelled', retryable: true }) })
    expect(openButton().disabled).toBe(false)
    openButton().click()
    fireEvent.keyDown(openButton(), { key: ' ' })
    expect(handlers.onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(row(), { key: 'F10', shiftKey: true })
    expect(labels()[0]).toBe('Retry')
  })
})

describe('a worktree whose work has landed', () => {
  const landing = (overrides: Partial<WorktreeLanding> = {}): WorktreeLanding => ({
    worktreeId: 'w1',
    branch: 'rewrite-the-pager',
    base: 'main',
    host: 'github',
    published: true,
    unmerged: 0,
    merged: true,
    readAt: NOW,
    ...overrides
  })
  const cleanMerge = {
    worktreeId: 'w1',
    baseRef: 'origin/main',
    state: 'clean',
    ahead: 1,
    conflicts: [],
    readAt: NOW
  } as WorktreeMergePreview

  it('says Merged in a plain chip instead of whether it would merge', () => {
    mount({ status: status(), landing: landing(), mergePreview: cleanMerge })

    const chip = screen.getByText('Merged')
    expect(chip.classList.contains('chip')).toBe(true)
    expect(screen.queryByRole('img', { name: /merge cleanly/ })).toBeNull()
  })

  it('says Landed for a child whose work is in its parent', () => {
    mount({
      worktree: worktree({ parentId: 'w0', baseRef: 'rework-auth' }),
      status: status(),
      landing: landing({ base: 'rework-auth', host: null, parent: { worktreeId: 'w0', name: 'Rework auth' } })
    })

    expect(screen.getByText('Landed').classList.contains('chip')).toBe(true)
    expect(screen.queryByText('Merged')).toBeNull()
  })

  it('leads its menu with Delete Worktree…', () => {
    mount({ status: status(), landing: landing() })
    fireEvent.contextMenu(row())

    expect(labels().slice(0, 2)).toEqual(['Delete Worktree…', 'Remove from teamree'])
    expect(labels().filter((label) => label === 'Delete Worktree…')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Worktree…' }))
    expect(handlers.onRemove).toHaveBeenCalled()
  })

  it('names an open pull request on hover, and keeps Remove last until it merges', () => {
    mount({
      status: status(),
      landing: landing({
        merged: false,
        unmerged: 1,
        pullRequest: { number: 12, url: 'https://github.com/a/b/pull/12', state: 'open' }
      })
    })

    expect(screen.queryByText('Merged')).toBeNull()
    expect(screen.getByText('Rewrite the pager').getAttribute('title')).toBe('Rewrite the pager · Pull Request #12')
    fireEvent.contextMenu(row())
    expect(labels().at(-1)).toBe('Delete Worktree…')
  })

  it('offers Keep This Run… when the task has other runs', () => {
    const onKeep = vi.fn()
    mount({ onKeep })
    fireEvent.contextMenu(row())

    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep This Run…' }))
    expect(onKeep).toHaveBeenCalled()
  })
})
