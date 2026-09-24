/** @vitest-environment jsdom */

// A pane row shows its harness as a glyph and keeps its text for what the glyph cannot say.

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
    expect(row?.querySelector('.pane-row__evidence')).toBeNull()
    expect(row?.querySelector('.pane-row__head')?.textContent).toContain('Edited calc.js (+1 -0)')
    expect(row?.title).toContain('Add a subtract function to codex')
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
