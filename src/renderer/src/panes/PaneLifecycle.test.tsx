/** @vitest-environment jsdom */

// The seven states a pane goes through, as the pane itself draws them: starting, working and asking
// at its edges while the program runs, and one end block with its marker and actions once it is gone.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode, Terminal } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'

const writes: Array<{ method: string; params: unknown }> = []

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div className="xterm" tabIndex={0} data-testid={`surface-${terminalId}`} />
  )
}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => {
      writes.push({ method, params })
      if (method === 'terminal.read')
        return Promise.resolve({ data: 'Error: test suite failed\r\nFAIL retry.test.ts\r\n' })
      return Promise.resolve({})
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { PaneTree } = await import('./PaneTree')
const { paneStage } = await import('./PaneLifecycle')

const terminal = (id: string, overrides: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId: 'w1',
  title: id,
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: new Date().setHours(11, 4, 0, 0),
  ...overrides
})

const onRelaunch = vi.fn()
const onClose = vi.fn()
const onResumeConversation = vi.fn()

function mount(pane: Terminal): void {
  const node: PaneNode = { kind: 'leaf', terminalId: pane.id }
  render(
    <PaneTree
      node={node}
      path={[]}
      worktreeId="w1"
      terminals={{ [pane.id]: pane }}
      focusedTerminalId={pane.id}
      onFocus={() => {}}
      onClose={onClose}
      onRelaunch={onRelaunch}
      onResumeConversation={onResumeConversation}
      onResize={() => {}}
      isAppChord={() => false}
      modifier={resolvePlatformModifier('darwin')}
      searchTerminalId={null}
      searchToken={0}
      onCloseSearch={() => {}}
    />
  )
}

const actions = (): string[] =>
  within(document.querySelector('.pane-end') as HTMLElement)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')

const marker = (): string => document.querySelector('.pane-end .pane-marker')?.textContent ?? ''

beforeEach(() => {
  writes.length = 0
  onRelaunch.mockReset()
  onClose.mockReset()
  onResumeConversation.mockReset()
})

afterEach(cleanup)

describe('the stage a pane is in', () => {
  const agent = (overrides: Partial<Terminal> = {}): Terminal => terminal('t', { agent: 'claude', ...overrides })

  it.each([
    ['starting', agent(), false],
    ['working', agent({ busy: true }), true],
    ['asking', agent({ agentEvent: { event: 'Notification', at: 1 } }), true],
    ['ready', agent({ agentEvent: { event: 'Stop', at: 1 } }), true],
    ['ended', agent({ running: false, exitCode: 0 }), true],
    ['ended', agent({ running: false, exitCode: 130 }), true],
    ['failed', agent({ running: false, exitCode: 1 }), true],
    ['restored', agent({ running: false, exitCode: 0, restored: 'stopped' }), true],
    ['failed', terminal('t', { running: false, exitCode: 2 }), true],
    ['ended', terminal('t', { run: 'dev', running: false, exitCode: 129 }), true]
  ] as const)('reads %s', (stage, pane, seen) => {
    expect(paneStage(pane, seen)).toBe(stage)
  })

  it('has none for a live shell, which draws no chrome', () => {
    expect(paneStage(terminal('t'), true)).toBeNull()
  })
})

describe('an ended agent', () => {
  it('shows a marker line and exactly Resume, New Session, Close', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 0 }))
    expect(marker()).toBe('Ended 11:04')
    expect(actions()).toEqual(['Resume', 'New Session', 'Close'])
    expect(screen.getByRole('group', { name: 'Claude Code ended' })).toBeTruthy()
    expect(document.querySelector('.pane__notice')).toBeNull()
  })

  it('says ^C for an agent interrupted out', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 130 }))
    expect(marker()).toBe('Ended 11:04 · ^C')
  })
})

describe('a failed pane', () => {
  it('offers an agent its conversation, a fresh run, its log and Close', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 1 }))
    expect(marker()).toBe('Exited 1 · 11:04')
    expect(actions()).toEqual(['Resume', 'Run Again', 'Show Log', 'Close'])
    fireEvent.click(screen.getByRole('button', { name: 'Run Again' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
  })

  it('offers a Run pane Run Again, Show Log and Close', () => {
    mount(terminal('t1', { run: 'test', running: false, exitCode: 1 }))
    expect(actions()).toEqual(['Run Again', 'Show Log', 'Close'])
    fireEvent.click(screen.getByRole('button', { name: 'Run Again' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1')
  })

  it('opens the pane’s output in a sheet on Show Log', async () => {
    mount(terminal('t1', { run: 'test', running: false, exitCode: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show Log' }))
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(/FAIL retry\.test\.ts/)).toBeTruthy()
    expect(writes.some((call) => call.method === 'terminal.read')).toBe(true)
  })
})

describe('a pane restored after relaunch', () => {
  it('shows Restored and exactly Resume, New Session', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 0, restored: 'stopped' }))
    expect(marker()).toBe('Restored · 11:04')
    expect(actions()).toEqual(['Resume', 'New Session'])
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResumeConversation).toHaveBeenCalledExactlyOnceWith('t1')
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
  })

  it('draws no chip for a pane that came back running', () => {
    mount(terminal('t1', { agent: 'claude', restored: 'agent', busy: true }))
    expect(screen.queryByText('resumed')).toBeNull()
    expect(document.querySelector('.pane-end')).toBeNull()
  })
})

describe('a live agent', () => {
  it('draws the shimmer until it has printed anything', () => {
    mount(terminal('t1', { agent: 'claude' }))
    expect(document.querySelector('.pane-starting .shimmer-line')).not.toBeNull()
    expect(document.querySelector('.pane-foot')?.textContent).toContain('Starting')
  })

  it('says it is working in the footer, and Stop interrupts it', () => {
    mount(terminal('t1', { agent: 'claude', busy: true }))
    const foot = document.querySelector('.pane-foot') as HTMLElement
    expect(foot.textContent).toMatch(/^Working/)
    expect(foot.querySelector('.pane-foot__dot--breathing .status--working')).not.toBeNull()
    fireEvent.click(within(foot).getByRole('button', { name: 'Stop' }))
    expect(writes).toContainEqual({ method: 'terminal.write', params: { terminalId: 't1', data: '\u001b' } })
  })

  it('keeps the footer when it goes quiet, so the terminal is never refit', () => {
    mount(terminal('t1', { agent: 'claude', agentEvent: { event: 'Stop', at: 1 } }))
    const foot = document.querySelector('.pane-foot') as HTMLElement
    expect(foot.textContent).toContain('Ready')
    expect(within(foot).queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('floats a card over the top while it asks, with the ask and Review', () => {
    mount(
      terminal('t1', {
        agent: 'claude',
        agentEvent: { event: 'Notification', at: 1, message: 'Claude needs your permission to use Bash' }
      })
    )
    const card = screen.getByRole('group', { name: 'Permission needed' })
    expect(card.className).toContain('pane-state--asking')
    expect(within(card).getByRole('button', { name: 'Review' })).toBeTruthy()
    expect(document.querySelector('.pane-foot')?.textContent).toContain('Asking')
  })

  it('draws no footer for a plain shell', () => {
    mount(terminal('t1', { busy: true }))
    expect(document.querySelector('.pane-foot')).toBeNull()
    expect(document.querySelector('.pane-state')).toBeNull()
  })

  it('counts the working time up', () => {
    vi.useFakeTimers()
    try {
      mount(terminal('t1', { agent: 'claude', busy: true }))
      act(() => {
        vi.advanceTimersByTime(18_000)
      })
      expect(document.querySelector('.pane-foot')?.textContent).toContain('18s')
    } finally {
      vi.useRealTimers()
    }
  })
})
