/** @vitest-environment jsdom */

// A one-line row with more chips than room: the name keeps its width, what needs you shows, the rest fold into `+N`.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal, Worktree, WorktreeLanding, WorktreeStatus } from '@shared/entities'
import { overlapChip, type OverlapChip } from './overlapChip'
import type { TaskFold } from './WorktreeRow'

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

const { WorktreeRow } = await import('./WorktreeRow')
const { useLedger } = await import('../state/ledgerStore')

const NOW = 1_700_000_000_000

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'long refactor',
  branch: 'long-refactor',
  path: '/repos/notes-wt/long-refactor',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: NOW - 60_000,
  issue: { number: 7, url: 'https://github.com/acme/notes/issues/7' }
}

const status: WorktreeStatus = {
  worktreeId: 'w1',
  branch: 'long-refactor',
  ahead: 0,
  behind: 4,
  staged: 0,
  unstaged: 1,
  untracked: 0,
  conflicted: 0,
  readAt: NOW
}

const landing: WorktreeLanding = {
  worktreeId: 'w1',
  branch: 'long-refactor',
  base: 'main',
  host: 'github',
  published: true,
  unmerged: 1,
  merged: false,
  readAt: NOW,
  pullRequest: {
    number: 42,
    url: 'https://github.com/acme/notes/pull/42',
    state: 'open',
    checks: { passing: 0, failing: 1, pending: 0, list: [{ name: 'test', state: 'fail' }] }
  }
}

const serving: Terminal = {
  id: 't1',
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/repos/notes-wt/long-refactor',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: NOW,
  ports: [{ port: 5173, pid: 5174, command: 'node' }]
}

const conflict = overlapChip(
  'w1',
  [{ worktreeId: 'w1', with: { worktreeId: 'w2' }, paths: ['index.md'], conflicts: ['index.md'] }],
  () => 'fast two'
) as OverlapChip

const noop = (): void => {}

function mount({ compact = true, task, chips = true }: {
  compact?: boolean
  task?: TaskFold
  chips?: boolean
} = {}): void {
  useLedger.setState({
    byProject: {
      p1: {
        projectId: 'p1',
        revision: 1,
        worktrees: [{ worktreeId: 'w1', claims: chips ? ['src/**'] : [], touched: [] }],
        notes: []
      }
    }
  })
  render(
    <ul>
      <WorktreeRow
        worktree={chips ? worktree : { ...worktree, issue: undefined }}
        status={chips ? status : undefined}
        mergePreview={undefined}
        {...(chips ? { landing, handoff: 'Taken by mate', overlap: { chip: conflict, onOpen: noop } } : {})}
        {...(task === undefined ? {} : { task })}
        terminals={chips ? [serving] : []}
        evidence={{}}
        watchers={{}}
        unread={new Set()}
        now={NOW}
        active={false}
        compact={compact}
        openIn={[]}
        onFocusTerminal={noop}
        onOpen={onOpen}
        onRetry={noop}
        onRemove={noop}
        onForget={noop}
        onReveal={noop}
        onCopyPath={noop}
        onCopyBranch={noop}
        onRename={noop}
      />
    </ul>
  )
}

const onOpen = vi.fn()
const title = (): HTMLElement => document.querySelector('.worktree__title') as HTMLElement
const facts = (): HTMLElement => title().querySelector('.worktree__facts') as HTMLElement
const shownKinds = (): string[] =>
  [...facts().children].map((chip) =>
    chip.classList.contains('overlap')
      ? 'overlap'
      : chip.classList.contains('prchip')
        ? 'pr'
        : chip.classList.contains('worktree__tally')
          ? 'tally'
          : chip.className
  )
const plus = (): HTMLElement | null => title().querySelector('.chip-fold')

afterEach(() => {
  onOpen.mockReset()
})

describe('a compact row with more chips than two', () => {
  it('shows a conflict and failing checks, and folds the other five into +5 listed on hover', () => {
    mount()
    expect(shownKinds()).toEqual(['overlap', 'pr'])
    expect(plus()?.textContent).toBe('+5')
    expect(plus()?.getAttribute('title')).toBe(
      ['4 behind · 1 uncommitted', 'Issue #7', ':5173', 'Taken by mate', 'Claims: src/**'].join('\n')
    )
  })

  it('puts a child that is asking ahead of everything', () => {
    mount({
      task: {
        collapsed: true,
        onCollapse: noop,
        rolled: { tone: 'waiting', from: 'payment' },
        tally: { done: 1, total: 2 },
        children: ['cart totals · done', 'payment · asking']
      }
    })
    expect(shownKinds()).toEqual(['tally', 'overlap'])
    expect(plus()?.textContent).toBe('+6')
  })

  it('lists the folded chips in a popover that opens without opening the row', () => {
    mount()
    fireEvent.click(plus() as HTMLElement)
    expect(onOpen).not.toHaveBeenCalled()
    const pop = screen.getByRole('dialog', { name: 'More on long refactor' })
    expect(within(pop).getByText('Taken by mate')).toBeTruthy()
    expect(within(pop).getByRole('link', { name: ':5173', hidden: true })).toBeTruthy()
    fireEvent.keyDown(pop, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // jsdom lays nothing out, so the line is told it is too narrow.
  it('folds the rest too when the line has no room for two beside the name', () => {
    const narrow = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('worktree__facts') && this.childElementCount > 0 ? 80 : 0
      })
    const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('worktree__facts') ? 30 : 0
    })
    act(() => mount())
    expect(facts().childElementCount).toBe(0)
    expect(plus()?.textContent).toBe('+7')
    narrow.mockRestore()
    room.mockRestore()
  })

  it('draws no +N with nothing to fold', () => {
    mount({ chips: false })
    expect(plus()).toBeNull()
  })
})

describe('a two-line row', () => {
  it('keeps every chip beside its branch, where the line wraps instead', () => {
    mount({ compact: false })
    expect(document.querySelector('.chip-fold')).toBeNull()
    const meta = document.querySelector('.worktree__meta') as HTMLElement
    expect(meta.querySelector('.overlap')).not.toBeNull()
    expect(meta.querySelector('.worktree__port')).not.toBeNull()
    expect(meta.querySelector('.worktree__claims')).not.toBeNull()
  })
})
