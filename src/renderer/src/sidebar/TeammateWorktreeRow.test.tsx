/** @vitest-environment jsdom */

// A teammate's worktree in the same list as your own: whose it is must be on the row, and
// that it is not yours to act on must be structural (a `div`, not a disabled button). The one
// exception is a pane, and only for reading.

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
  branch: 'priya/relay-budget',
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

const watchButton = (): HTMLElement => document.querySelector('button.pane-row') as HTMLElement

beforeEach(() => {
  onWatch.mockReset()
})

describe('whose worktree this is', () => {
  it('carries the handle on the row itself, not only on hover', () => {
    mount()
    const item = document.querySelector('.worktree') as HTMLElement
    expect(within(item).getByText('priya')).toBeTruthy()
    expect(within(item).getByText('Fix the relay budget')).toBeTruthy()
    expect(within(item).getByText('priya/relay-budget')).toBeTruthy()
  })

  it('leaves out a branch that is only its name slugified', () => {
    mount(theirs({ branch: 'fix-the-relay-budget' }))
    expect(screen.queryByText('fix-the-relay-budget')).toBeNull()
  })

  it('says whose it is first on hover, because that changes what the rest means', () => {
    mount()
    const title = document.querySelector('.worktree__row')?.getAttribute('title') ?? ''
    expect(title).toContain('priya’s worktree on their machine')
    expect(title.indexOf('priya')).toBeLessThan(title.indexOf('priya/relay-budget'))
  })
})

describe('what cannot be done to it', () => {
  // A disabled control is a thing that would work if something were different; this will not.
  it('offers no way to open, retry or remove it — not even a dead one', () => {
    mount()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Fix the relay budget/ })).toBeNull()
  })

  it('offers exactly one control, and it only reads', () => {
    mount()
    const buttons = document.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('title')).toContain('reading only')
  })
})

describe('a pane of theirs', () => {
  it('is a button that says whose it is, what it is doing, and that it is read-only', () => {
    mount()
    const button = watchButton()
    expect(button.getAttribute('title')).toBe('Watch priya’s Claude Code · working · reading only')
  })

  it('says whether this window has it open, as a selected row rather than a colour', () => {
    mount(theirs(), ['priya:t7'])
    const button = watchButton()
    expect(button.getAttribute('aria-selected')).toBe('true')
    // A toggle whose hover text still offers what it already did lies about half its presses.
    expect(button.getAttribute('title')).toBe('Stop watching priya’s Claude Code')
  })

  it('is not selected when a different pane is the one being watched', () => {
    mount(theirs(), ['priya:t9'])
    expect(watchButton().getAttribute('aria-selected')).toBe('false')
  })

  it('hands the whole pane back, with the size a watcher must letterbox to', () => {
    mount()
    watchButton().click()
    expect(onWatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ terminalId: 'priya:t7', handle: 'priya', cols: 120, rows: 40, label: 'Claude Code' })
    )
  })

  // A teammate's pane does not stream until opened; a quoted line before then was never sent.
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
    expect(watchButton().querySelector('.pane-row__head .pane-row__evidence')?.textContent).toBe('running tests')
  })

  it('leaves the one dot to the worktree row', () => {
    mount()
    expect(document.querySelectorAll('.activity')).toHaveLength(1)
    expect(watchButton().querySelector('.activity')).toBeNull()
    expect(watchButton().querySelector('.pane-row__head')?.children[0]?.getAttribute('class')).toContain('agent-glyph')
  })

  it('reads failed in the time slot instead of the age', () => {
    mount(theirs({ panes: [pane({ running: false, busy: false, exitCode: 1 })] }))
    const since = watchButton().querySelector('.pane-row__since')
    expect(since?.textContent).toBe('failed')
    expect(since?.className).toBe('pane-row__since pane-row__since--failed')
  })

  it('shows no pane list at all for a worktree with no panes open', () => {
    mount(theirs({ panes: [] }))
    expect(document.querySelector('button')).toBeNull()
  })
})

describe('a teammate who has gone away', () => {
  // A worktree disappearing reads as a worktree deleted.
  it('stays on the list and says how old the picture is', () => {
    mount(theirs({ live: false, heardAt: NOW - 240_000 }))
    // `heardAt` moves when a snapshot changes, not on contact: the age of the picture, not of the
    // absence. See `teammateStaleness`.
    expect(screen.getByText('away · picture 4m old')).toBeTruthy()
    expect(screen.getByText('Fix the relay budget')).toBeTruthy()
  })

  // Nothing is known about the worktree, and the sentence must not imply otherwise.
  it('says their machine is not connected, never anything about the worktree', () => {
    mount(theirs({ live: false, heardAt: NOW - 240_000 }))
    const detail = screen.getByLabelText(/not connected/).getAttribute('aria-label') ?? ''
    expect(detail).toBe('priya’s machine is not connected · showing what it had 4m ago')
  })

  // A badge that blinked on every relay restart would train a reader to ignore it.
  it('says nothing during the grace a reconnection takes', () => {
    mount(theirs({ live: false, heardAt: NOW - 5_000 }))
    expect(screen.queryByText(/away/)).toBeNull()
  })

  it('says nothing at all while the link is up', () => {
    mount(theirs({ heardAt: NOW - 600_000 }))
    expect(screen.queryByText(/away/)).toBeNull()
  })

  // The owner's measured silence plus the time it has sat here: the only arithmetic that trusts no other clock.
  it('adds the time since the snapshot arrived to the silence its owner measured', () => {
    mount(theirs({ live: false, heardAt: NOW - 120_000, panes: [pane({ quietForMs: 180_000 })] }))
    expect(within(watchButton()).getByText('5m')).toBeTruthy()
  })
})
