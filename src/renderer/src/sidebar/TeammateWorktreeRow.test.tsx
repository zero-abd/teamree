/** @vitest-environment jsdom */

// A teammate's worktree in the same list as your own: whose it is must be on the row, and
// that it is not yours to act on must be structural (a `div`, not a disabled button). The one
// exception is a pane, and only for reading.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerPane, TeammateWorktree } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => Promise.reject(new Error('not in this test')),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { teammateRows } = await import('./teammateRows')
const { TeammateWorktreeRow } = await import('./TeammateWorktreeRow')

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
const onAnswer = vi.fn()

function mount(worktree: TeammateWorktree = theirs(), watchingPaneIds: string[] = []): void {
  const [row] = teammateRows([worktree], NOW, {})
  render(
    <ul>
      <TeammateWorktreeRow row={row!} watchingPaneIds={watchingPaneIds} onWatch={onWatch} onAnswer={onAnswer} />
    </ul>
  )
}

const watchButton = (): HTMLElement => document.querySelector('button.pane-row') as HTMLElement

beforeEach(() => {
  onWatch.mockReset()
  onAnswer.mockReset()
})

describe('a pane of theirs that is asking', () => {
  const menu = {
    prompt: '1a2b3c4d',
    choices: [
      { label: 'Yes', keys: ['\r'] },
      { label: 'Yes, Always', keys: ['2'] },
      { label: 'No…', keys: null }
    ]
  }
  const asking = (overrides: Partial<PeerPane> = {}): TeammateWorktree =>
    theirs({ panes: [pane({ busy: false, asking: true, menu, ...overrides })] })

  it('reads asking in amber on the row and on the worktree’s dot', () => {
    mount(asking())
    expect(document.querySelector('.pane-row__since--waiting')?.textContent).toBe('asking')
    expect(document.querySelector('.worktree__title .activity--waiting')).toBeTruthy()
  })

  it('offers the owner’s answers, and a click hands back the pane and the choice', () => {
    mount(asking())
    const answers = screen.getByRole('group', { name: 'Answer' })
    expect(
      within(answers)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Yes', 'Always', 'No…'])
    fireEvent.click(within(answers).getByRole('button', { name: 'Yes' }))
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'priya:t7', answering: '1a2b3c4d' }),
      menu.choices[0]
    )
    expect(onWatch).not.toHaveBeenCalled()
  })

  it('offers no answers where a keystroke would be refused: muted, or their machine away', () => {
    mount(asking({ muted: true }))
    expect(screen.queryByRole('group', { name: 'Answer' })).toBeNull()
    document.body.innerHTML = ''
    mount({ ...asking(), live: false })
    expect(screen.queryByRole('group', { name: 'Answer' })).toBeNull()
  })

  it('opens the first pane when the task’s title is clicked', () => {
    mount(asking())
    fireEvent.click(screen.getByText('Fix the relay budget'))
    expect(onWatch).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'priya:t7' }))
  })
})

describe('whose worktree this is', () => {
  it('holds its row and its panes in one box, as your own', () => {
    mount()
    const box = document.querySelector('.worktree') as HTMLElement
    expect(box.querySelector(':scope > .worktree__row')).toBeTruthy()
    expect(box.querySelectorAll(':scope > .panes .pane-row')).toHaveLength(1)
  })

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

  it('is named once, by whose it is and its state, with its glyph unnamed', () => {
    mount()
    const button = watchButton()
    expect(button.getAttribute('aria-label')).toBe('priya’s Claude Code, working')
    expect(button.querySelector('.agent-glyph')?.getAttribute('aria-hidden')).toBe('true')
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
        <TeammateWorktreeRow row={row!} watchingPaneIds={['priya:t7']} onWatch={onWatch} onAnswer={onAnswer} />
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

describe('what the teammate is doing', () => {
  it('shows the task as the title and the stage and report on the line', () => {
    mount(
      theirs({
        task: 'Fix the relay budget for bursts',
        stage: 'done',
        report: { outcome: 'succeeded', summary: 'Budget holds under load.' }
      })
    )
    expect(document.querySelector('.worktree__name')?.textContent).toBe('Fix the relay budget for bursts')
    expect(document.querySelector('.worktree__stage')?.textContent).toBe('done')
    expect(document.querySelector('.worktree__report')?.textContent).toBe('Budget holds under load.')
  })

  it('sits one level deeper for a child', () => {
    const rows = teammateRows(
      [
        theirs({ id: 'priya:parent', name: 'Parent' }),
        theirs({ id: 'priya:child', name: 'Child', parentId: 'priya:parent' })
      ],
      NOW,
      {}
    )
    render(
      <ul>
        {rows.map((row) => (
          <TeammateWorktreeRow key={row.id} row={row} watchingPaneIds={[]} onWatch={onWatch} onAnswer={onAnswer} />
        ))}
      </ul>
    )
    const levels = [...document.querySelectorAll('.worktree__open--teammate')].map((item) =>
      item.getAttribute('aria-level')
    )
    expect(levels).toEqual(['2', '3'])
  })
})
