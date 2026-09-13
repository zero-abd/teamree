/** @vitest-environment jsdom */

// A teammate's worktree, in the same list as your own.
//
// Sharing the list is the whole risk: two of the facts on this row must never
// be mistaken, and neither is visible to `teammateRows.test.ts`, which only
// proves the model. Whose it is has to be on the row and not only in a tooltip.
// And that it is not yours to act on has to be structural — the row is a `div`
// rather than a disabled button, because a disabled control is a thing that
// would work if something were different, and this will not.
//
// The one exception is a pane, and only in one direction: reading.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerPane, TeammateWorktree } from '@shared/entities'
import { teammateRows } from './teammateRows'
import { TeammateWorktreeRow } from './TeammateWorktreeRow'

const NOW = 1_700_000_000_000

const pane = (overrides: Partial<PeerPane> = {}): PeerPane => ({
  id: 'priya:t7',
  title: 'claude',
  shell: '/bin/zsh',
  agent: 'claude',
  running: true,
  busy: true,
  cols: 120,
  rows: 40,
  quietForMs: 0,
  ...overrides
})

const theirs = (overrides: Partial<TeammateWorktree> = {}): TeammateWorktree => ({
  id: 'priya:w3',
  name: 'Fix the relay budget',
  branch: 'fix-the-relay-budget',
  state: 'ready',
  panes: [pane()],
  handle: 'priya',
  publicKey: 'priya-key',
  heardAt: NOW,
  live: true,
  ...overrides
})

const onWatch = vi.fn()

function mount(worktree: TeammateWorktree = theirs(), watchingPaneIds: string[] = []): void {
  const [row] = teammateRows([worktree], NOW, {})
  render(
    <ul>
      <TeammateWorktreeRow row={row!} watchingPaneIds={watchingPaneIds} onWatch={onWatch} />
    </ul>
  )
}

beforeEach(() => {
  onWatch.mockReset()
})

describe('whose worktree this is', () => {
  it('carries the handle on the row itself, not only on hover', () => {
    mount()
    const item = screen.getAllByRole('listitem')[0] as HTMLElement
    expect(within(item).getByText('priya')).toBeTruthy()
    expect(within(item).getByText('Fix the relay budget')).toBeTruthy()
    expect(within(item).getByText('fix-the-relay-budget')).toBeTruthy()
  })

  it('says whose it is first on hover, because that changes what the rest means', () => {
    mount()
    const title = document.querySelector('.worktree__row')?.getAttribute('title') ?? ''
    expect(title).toContain('priya’s worktree on their machine')
    expect(title.indexOf('priya')).toBeLessThan(title.indexOf('fix-the-relay-budget'))
  })
})

describe('what cannot be done to it', () => {
  // Not a disabled button: a disabled control is a thing that would work if
  // something were different, and removing somebody else's checkout will not.
  it('offers no way to open, retry or remove it — not even a dead one', () => {
    mount()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Fix the relay budget/ })).toBeNull()
  })

  it('offers exactly one control, and it only reads', () => {
    mount()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('title')).toContain('reading only')
  })
})

describe('a pane of theirs', () => {
  it('is a button that says whose it is, what it is doing, and that it is read-only', () => {
    mount()
    const button = screen.getByRole('button')
    expect(button.getAttribute('title')).toBe('Watch priya’s claude · working · reading only')
  })

  it('says whether this window has it open, as a pressed state rather than a colour', () => {
    mount(theirs(), ['priya:t7'])
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    // And what a second press would do, because a toggle whose hover text still
    // offers what it already did is a button that lies about half its presses.
    expect(button.getAttribute('title')).toBe('Stop watching priya’s claude')
  })

  it('is not pressed when a different pane is the one being watched', () => {
    mount(theirs(), ['priya:t9'])
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false')
  })

  it('hands the whole pane back, with the size a watcher must letterbox to', () => {
    mount()
    screen.getByRole('button').click()
    expect(onWatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ terminalId: 'priya:t7', handle: 'priya', cols: 120, rows: 40, label: 'claude' })
    )
  })

  // A teammate's pane does not stream until somebody opens it, so a quoted
  // line on a row nobody is watching would be a line this machine was never
  // sent.
  it('quotes nothing until somebody is actually watching it', () => {
    mount()
    expect(document.querySelector('.pane-row__evidence')).toBeNull()
  })

  it('quotes what a watched pane has said since it was opened', () => {
    const [row] = teammateRows([theirs()], NOW, { 'priya:t7': 'running tests' })
    render(
      <ul>
        <TeammateWorktreeRow row={row!} watchingPaneIds={['priya:t7']} onWatch={onWatch} />
      </ul>
    )
    expect(screen.getByText('running tests')).toBeTruthy()
  })

  it('shows no pane list at all for a worktree with no panes open', () => {
    mount(theirs({ panes: [] }))
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('a teammate who has gone away', () => {
  // The row stays where it was — a worktree disappearing reads as a worktree
  // deleted — and says how old the picture is instead.
  it('stays on the list and says how old the picture is', () => {
    mount(theirs({ live: false, heardAt: NOW - 240_000 }))
    // And says *which* age the number is. `heardAt` moves when a snapshot
    // changes rather than on contact, so this is the age of the picture and not
    // of the absence — `away · 4m` beside a teammate who went thirty seconds
    // ago claimed the second when it knew only the first. The number is the
    // same one; the word beside it is what was wrong. See `teammateStaleness`.
    expect(screen.getByText('away · picture 4m old')).toBeTruthy()
    expect(screen.getByText('Fix the relay budget')).toBeTruthy()
  })

  // "Their machine is away" is the fact. Nothing at all is known about the
  // worktree, and the sentence must not imply otherwise.
  it('says their machine is not connected, never anything about the worktree', () => {
    mount(theirs({ live: false, heardAt: NOW - 240_000 }))
    const detail = screen.getByLabelText(/not connected/).getAttribute('aria-label') ?? ''
    expect(detail).toBe('priya’s machine is not connected. This is what they were showing 4m ago.')
  })

  // Reconnection is ordinary. A badge that blinked on every relay restart
  // would train a reader to ignore it.
  it('says nothing during the grace a reconnection takes', () => {
    mount(theirs({ live: false, heardAt: NOW - 5_000 }))
    expect(screen.queryByText(/away/)).toBeNull()
  })

  it('says nothing at all while the link is up', () => {
    mount(theirs({ heardAt: NOW - 600_000 }))
    expect(screen.queryByText(/away/)).toBeNull()
  })

  // The age crossed the wire as a duration the owner measured, plus however
  // long it has been sitting here — the only arithmetic that does not involve
  // believing somebody else's clock.
  it('adds the time since the snapshot arrived to the silence its owner measured', () => {
    mount(theirs({ live: false, heardAt: NOW - 120_000, panes: [pane({ quietForMs: 180_000 })] }))
    expect(within(screen.getByRole('button')).getByText('5m')).toBeTruthy()
  })
})
