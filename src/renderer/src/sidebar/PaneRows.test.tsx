/** @vitest-environment jsdom */

// A pane row shows its harness as a glyph and keeps its text for what the glyph cannot say.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'
import { agentRows } from './agentRows'
import { PaneRows } from './PaneRows'

const terminal = (overrides: Partial<Terminal> & { id: string }): Terminal => ({
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

const mount = (...panes: Terminal[]): HTMLElement[] => mountUnread([], ...panes)

const mountUnread = (unread: string[], ...panes: Terminal[]): HTMLElement[] => {
  render(
    <PaneRows
      rows={agentRows(panes, 'w1', 0)}
      watchers={{}}
      unread={new Set(unread)}
      now={0}
      onFocusTerminal={() => {}}
    />
  )
  return screen.getAllByRole('button')
}

describe('PaneRows', () => {
  it('draws an agent as its harness glyph, labelled with the harness name only', () => {
    const [row] = mount(terminal({ id: 't1', agent: 'claude' }))
    const glyph = within(row as HTMLElement).getByRole('img')
    expect(glyph.getAttribute('aria-label')).toBe('Claude Code')
    expect(row?.querySelector('.pane-row__label')?.textContent).toBe('')
  })

  it('keeps the task name as text beside the glyph', () => {
    const [row] = mount(terminal({ id: 't1', agent: 'codex', label: 'auth refactor' }))
    expect(within(row as HTMLElement).getByRole('img', { name: 'Codex' })).toBeTruthy()
    expect(row?.querySelector('.pane-row__label')?.textContent).toBe('auth refactor')
  })

  it('draws a harness found in a plain shell’s foreground', () => {
    const [row] = mount(terminal({ id: 't1', title: '✳ Claude Code', foregroundAgent: 'claude' }))
    expect(within(row as HTMLElement).getByRole('img', { name: 'Claude Code' })).toBeTruthy()
  })

  it('gives a plain shell the terminal glyph and its own name', () => {
    const [row] = mount(terminal({ id: 't1', title: 'npm test' }))
    expect(within(row as HTMLElement).queryByRole('img')).toBeNull()
    expect(row?.querySelector('.agent-glyph--terminal')).not.toBeNull()
    expect(row?.querySelector('.pane-row__label')?.textContent).toBe('npm test')
  })

  // The worktree row carries the one dot; a dot on every pane repeated it.
  it('draws no dot: the glyph leads the row', () => {
    const [row] = mount(terminal({ id: 't1', agent: 'claude', busy: true }))
    const head = row?.querySelector('.pane-row__head')
    expect(row?.querySelector('.activity')).toBeNull()
    expect(head?.children[0]?.getAttribute('class')).toContain('agent-glyph')
    expect(row?.title).toContain('Claude Code · working')
  })

  it('reads the age in the time slot while nothing needs you', () => {
    const [working, idle, stopped] = mount(
      terminal({ id: 't1', agent: 'claude', busy: true }),
      terminal({ id: 't2', lastBellAt: 1 }),
      terminal({ id: 't3', agent: 'codex' })
    )
    for (const row of [working, idle, stopped]) {
      expect(row?.querySelector('.pane-row__since')?.className).toBe('pane-row__since')
      expect(row?.querySelector('.pane-row__since')?.textContent).toBe('now')
    }
    expect(idle?.title).toContain('zsh · idle')
    expect(stopped?.title).toContain('Codex · stopped')
  })

  it('reads asking in the time slot, in its tone', () => {
    const [row] = mount(
      terminal({ id: 't1', agent: 'claude', agentEvent: { event: 'Notification', at: 0, detail: 'permission_prompt' } })
    )
    const since = row?.querySelector('.pane-row__since')
    expect(since?.textContent).toBe('asking')
    expect(since?.className).toBe('pane-row__since pane-row__since--waiting')
    expect(row?.title).toContain('asking')
  })

  it('reads failed in the time slot, in its tone', () => {
    const [row] = mount(terminal({ id: 't1', title: 'npm test', running: false, exitCode: 1 }))
    const since = row?.querySelector('.pane-row__since')
    expect(since?.textContent).toBe('failed')
    expect(since?.className).toBe('pane-row__since pane-row__since--failed')
  })

  it('marks an unread pane by weight alone', () => {
    const [row] = mountUnread(['t1'], terminal({ id: 't1', title: 'npm test' }))
    expect(row?.className).toContain('pane-row--unread')
    expect(row?.querySelector('.activity, .pip')).toBeNull()
    expect(row?.title).toContain('unread')
  })
})

describe('a pane named after its worktree', () => {
  const mountIn = (
    worktreeName: string,
    evidence: Record<string, string | null>,
    ...panes: Terminal[]
  ): HTMLElement[] => {
    render(
      <PaneRows
        rows={agentRows(panes, 'w1', 0, evidence)}
        worktreeName={worktreeName}
        watchers={{}}
        unread={new Set()}
        now={0}
        onFocusTerminal={() => {}}
      />
    )
    return screen.getAllByRole('button')
  }

  it('shows its glyph and last line on one line, and the name only on hover', () => {
    const [row] = mountIn(
      'Add a subtract function to codex',
      { t1: 'Edited calc.js (+1 -0)' },
      terminal({ id: 't1', agent: 'codex', label: 'Add a subtract function to codex' })
    )
    expect(row?.querySelector('.pane-row__label')).toBeNull()
    expect(row?.querySelector('.pane-row__head .pane-row__evidence')?.textContent).toBe('Edited calc.js (+1 -0)')
    expect(row?.title).toContain('Add a subtract function to codex')
  })

  // Every row one line high: a quoted line under some rows and not others knocked them out of line.
  it('puts another pane’s last line beside its name, on the same line', () => {
    const [, shell] = mountIn(
      'pager',
      { t2: 'Done in 2.1s' },
      terminal({ id: 't1', agent: 'codex', label: 'pager' }),
      terminal({ id: 't2', title: 'zsh' })
    )
    expect(shell?.children).toHaveLength(1)
    const head = shell?.querySelector('.pane-row__head')
    expect(head?.querySelector('.pane-row__label')?.textContent).toBe('zsh')
    expect(head?.querySelector('.pane-row__evidence')?.textContent).toBe('Done in 2.1s')
  })

  it('keeps the name of any other pane', () => {
    const [, other] = mountIn(
      'pager',
      {},
      terminal({ id: 't1', agent: 'codex', label: 'pager' }),
      terminal({ id: 't2', title: 'npm test' })
    )
    expect(other?.querySelector('.pane-row__label')?.textContent).toBe('npm test')
  })
})

// Enter goes to the pane, so typing lands in it; Space shows it and leaves the keyboard on the row.
describe('the keyboard on a pane row', () => {
  const mountKeys = async (): Promise<{ row: HTMLElement; focus: ReturnType<typeof vi.fn>; asked: string[] }> => {
    const { onRegionRequest } = await import('../shell/regions')
    const asked: string[] = []
    onRegionRequest((region) => asked.push(region))
    const focus = vi.fn(async () => {})
    render(
      <PaneRows
        rows={agentRows([terminal({ id: 't1' })], 'w1', 0)}
        watchers={{}}
        unread={new Set()}
        now={0}
        onFocusTerminal={focus}
      />
    )
    return { row: screen.getByRole('button'), focus, asked }
  }

  it('takes Enter to the pane itself', async () => {
    const { row, focus, asked } = await mountKeys()
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(focus).toHaveBeenCalledExactlyOnceWith('t1')
    await vi.waitFor(() => expect(asked).toEqual(['panes']))
  })

  it('shows the pane on Space and keeps the keyboard on the row', async () => {
    const { row, focus, asked } = await mountKeys()
    // The pane coming to the front takes the focus, as a terminal does.
    const pane = document.body.appendChild(document.createElement('textarea'))
    focus.mockImplementation(async () => pane.focus())
    row.focus()
    fireEvent.keyDown(row, { key: ' ' })
    fireEvent.click(row, { detail: 0 })
    expect(focus).toHaveBeenCalledExactlyOnceWith('t1')
    await vi.waitFor(() => expect(document.activeElement).toBe(row))
    expect(asked).toEqual([])
    pane.remove()
  })
})
