/** @vitest-environment jsdom */

// A pane's subagents under its row: nested, timed, and opening their transcript.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Subagent, Terminal } from '@shared/entities'

const call = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (...args: unknown[]) => call(...args),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { agentRows } = await import('./agentRows')
const { PaneRows } = await import('./PaneRows')
const { elapsedLabel, subagentTree } = await import('./subagentTree')

afterEach(() => {
  cleanup()
  call.mockReset()
})

const NOW = 1_000_000

const subagent = (overrides: Partial<Subagent> & { id: string }): Subagent => ({
  description: overrides.id,
  status: 'running',
  startedAt: NOW - 200_000,
  ...overrides
})

const pane = (subagents: Subagent[]): Terminal => ({
  id: 't1',
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: true,
  agent: 'claude',
  lastOutputAt: NOW,
  subagents
})

describe('subagentTree', () => {
  it('puts children under their parent, and an orphan at the top', () => {
    const tree = subagentTree([
      subagent({ id: 'a' }),
      subagent({ id: 'b', parentId: 'a' }),
      subagent({ id: 'c', parentId: 'gone' }),
      subagent({ id: 'd', parentId: 'b' })
    ])
    expect(tree.map(({ subagent: { id }, depth }) => `${id}:${depth}`)).toEqual(['a:0', 'b:1', 'd:2', 'c:0'])
  })

  it('writes durations the way the agent’s own footer does', () => {
    expect(elapsedLabel(8_000)).toBe('8s')
    expect(elapsedLabel(200_000)).toBe('3m 20s')
    expect(elapsedLabel(3_900_000)).toBe('1h 5m')
  })
})

describe('PaneRows with subagents', () => {
  const mount = (subagents: Subagent[]): void => {
    render(
      <PaneRows
        tree
        rows={agentRows([pane(subagents)], 'w1', NOW)}
        watchers={{}}
        unread={new Set()}
        now={NOW}
        onFocusTerminal={() => {}}
      />
    )
  }

  it('draws each subagent under the pane with its status and time, a level deeper', () => {
    mount([
      subagent({ id: 'a', description: 'Simplify the status line' }),
      subagent({ id: 'b', description: 'Research', parentId: 'a', status: 'failed', endedAt: NOW - 150_000 })
    ])
    const [first, second] = screen.getAllByRole('treeitem').filter((row) => row.classList.contains('subagent-row'))
    expect(first?.textContent).toBe('Simplify the status line3m 20s')
    expect(first?.getAttribute('aria-level')).toBe('4')
    expect(second?.getAttribute('aria-level')).toBe('5')
    expect(second?.querySelector('.activity--failed')).not.toBeNull()
    expect(second?.textContent).toContain('50s')
  })

  it('draws nothing more for a pane with none', () => {
    mount([])
    expect(document.querySelector('.subagents')).toBeNull()
  })

  it('opens the transcript, read-only, on a click', async () => {
    call.mockResolvedValue({
      agentId: 'a',
      truncated: false,
      lines: [
        { kind: 'prompt', text: 'Find the bug' },
        { kind: 'tool', text: 'Bash npm test' }
      ]
    })
    mount([subagent({ id: 'a', description: 'Hunt', status: 'done', endedAt: NOW })])
    await act(async () => {
      fireEvent.click(screen.getByText('Hunt'))
    })
    expect(call).toHaveBeenCalledWith('terminal.subagentTranscript', { terminalId: 't1', agentId: 'a' })
    const dialog = screen.getByRole('dialog', { name: 'Hunt' })
    expect(dialog.textContent).toContain('Find the bug')
    expect(dialog.textContent).toContain('Bash npm test')
    expect(dialog.querySelector('textarea, input')).toBeNull()
  })
})
