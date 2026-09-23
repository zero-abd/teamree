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

const mount = (...panes: Terminal[]): HTMLElement[] => {
  render(
    <PaneRows rows={agentRows(panes, 'w1', 0)} watchers={{}} unread={new Set()} now={0} onFocusTerminal={() => {}} />
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

  it('keeps the status dot apart from the glyph', () => {
    const [row] = mount(terminal({ id: 't1', agent: 'claude', busy: true }))
    const head = row?.querySelector('.pane-row__head')
    expect(head?.children[0]?.className).toBe('activity activity--working')
    expect(head?.children[1]?.getAttribute('class')).toContain('agent-glyph')
  })
})
