/** @vitest-environment jsdom */

// The seven states a pane goes through, as the pane itself draws them: starting, working and asking
// at its edges while the program runs, and one end block with its marker and actions once it is gone.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode, Terminal, Worktree } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'

const writes: Array<{ method: string; params: unknown }> = []
let output = 'Error: test suite failed\r\nFAIL retry.test.ts\r\n'

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div className="xterm" tabIndex={0} data-testid={`surface-${terminalId}`}>
      <textarea className="xterm-helper-textarea" aria-label={`input ${terminalId}`} />
    </div>
  )
}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => {
      writes.push({ method, params })
      if (method === 'terminal.read') return Promise.resolve({ data: output })
      return Promise.resolve({})
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { PaneTree } = await import('./PaneTree')
const { paneStage } = await import('./PaneLifecycle')
const { useMessageStore } = await import('../state/messages')
const { focusAskAnswer } = await import('./askCards')
const { useWorkspaceStore } = await import('../state/workspaceStore')

const worktree = (report: { outcome: 'succeeded' | 'failed'; summary: string }): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'fix batch 1',
  branch: 'fix-batch-1',
  path: '/repos/pager',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  report: { ...report, paths: [], at: 1 }
})

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

/** Draws the pane; the returned function draws it again with the terminal as it is now. */
function mount(pane: Terminal): (next: Terminal) => void {
  const drawn = render(tree(pane))
  return (next) => drawn.rerender(tree(next))
}

function tree(pane: Terminal): React.JSX.Element {
  const node: PaneNode = { kind: 'leaf', terminalId: pane.id }
  return (
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
  useWorkspaceStore.setState({ worktrees: [] })
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
    ['failed', agent({ running: false, exitCode: 1, restored: 'stopped', stoppedFor: 'failed' }), true],
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
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 0, resumable: true }))
    expect(marker()).toBe('Ended 11:04')
    expect(actions()).toEqual(['Resume', 'New Session', 'Close'])
    expect(screen.getByRole('group', { name: 'Claude Code ended' })).toBeTruthy()
    expect(document.querySelector('.pane__notice')).toBeNull()
  })

  // Its Resume would have started a new session under the wrong word.
  it('offers New Session first and no Resume when it has no conversation to pick up', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 0 }))
    expect(actions()).toEqual(['New Session', 'Close'])
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
    fireEvent.keyDown(screen.getByTestId('surface-t1'), { key: 'Enter' })
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
  })

  // Quit with ^C at 04:55 after printing last at 04:46, it read "Ended 04:46".
  it('says when it ended, not when it last printed', () => {
    const endedAt = new Date().setHours(11, 58, 0, 0)
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 130, endedAt }))
    expect(marker()).toBe('Ended 11:58 · ^C')
    cleanup()
    mount(
      terminal('t1', {
        agent: 'claude',
        running: false,
        exitCode: 1,
        restored: 'stopped',
        stoppedFor: 'failed',
        endedAt
      })
    )
    expect(marker()).toBe('Exited 1 · 11:58')
  })

  it('says ^C for an agent interrupted out', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 130 }))
    expect(marker()).toBe('Ended 11:04 · ^C')
  })
})

describe('a failed pane', () => {
  it('offers an agent its conversation, a fresh run, its log and Close', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 1, resumable: true }))
    expect(marker()).toBe('Exited 1 · 11:04')
    expect(actions()).toEqual(['Resume', 'Run Again', 'Show Log', 'Close'])
    fireEvent.click(screen.getByRole('button', { name: 'Run Again' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
  })

  it('offers an agent with nothing to resume Run Again first', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 1 }))
    expect(actions()).toEqual(['Run Again', 'Show Log', 'Close'])
  })

  // After a relaunch it read plain "Restored": the exit code and Show Log were gone.
  it('stays failed through a relaunch, with its exit code and Show Log', () => {
    mount(terminal('t1', { agent: 'claude', running: false, exitCode: 1, restored: 'stopped', stoppedFor: 'failed' }))
    expect(marker()).toBe('Exited 1 · 11:04')
    expect(actions()).toEqual(['Run Again', 'Show Log', 'Close'])
    cleanup()
    const pane = { agent: 'claude', running: false, exitCode: 1, restored: 'stopped', stoppedFor: 'failed' } as const
    mount(terminal('t1', { ...pane, resumable: true }))
    expect(actions()).toEqual(['Resume', 'Run Again', 'Show Log', 'Close'])
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

describe('a command that was not found', () => {
  afterEach(() => {
    output = 'Error: test suite failed\r\nFAIL retry.test.ts\r\n'
  })

  it('names the missing tool on a Run pane that exited 127, with the fix', async () => {
    output = '\u001b[1mzsh:1: command not found: pnpm\r\n'
    mount(terminal('t1', { run: 'dev', running: false, exitCode: 127 }))
    await act(async () => {})
    expect(marker()).toBe('pnpm not found · 11:04')
    expect(document.querySelector('.pane-end__hint')?.textContent).toBe('Install with: npm i -g pnpm')
    expect(actions()).toEqual(['Run Again', 'Show Log', 'Close'])
  })

  it('names it on a failed setup, which offers the held agent and a shell', async () => {
    output = 'zsh:1: command not found: pnpm\r\n'
    const held = { agentCommand: 'claude', label: 'fix batch 1', task: 'fix batch 1' }
    useWorkspaceStore.setState({ setupHolds: { w1: held } })
    const startHeldAgent = vi.spyOn(useWorkspaceStore.getState(), 'startHeldAgent').mockResolvedValue()
    try {
      mount(terminal('t1', { label: 'setup', run: 'setup', command: 'pnpm i', running: false, exitCode: 127 }))
      await act(async () => {})
      expect(marker()).toBe('pnpm not found · 11:04')
      expect(document.querySelector('.pane-end__hint')?.textContent).toBe('Install with: npm i -g pnpm')
      expect(actions()).toEqual(['Run Again', 'Start Agent Anyway', 'Open Shell', 'Show Log', 'Close'])
      fireEvent.click(screen.getByRole('button', { name: 'Start Agent Anyway' }))
      expect(startHeldAgent).toHaveBeenCalledWith('w1')
    } finally {
      startHeldAgent.mockRestore()
      useWorkspaceStore.setState({ setupHolds: {} })
    }
  })
})

describe('a setup still running', () => {
  it('says Setting up and its command, its output hidden until asked for', () => {
    mount(terminal('t1', { label: 'setup', run: 'setup', command: 'npm install', title: 'npm' }))
    expect(screen.getByRole('status', { name: 'Setting up · npm install' })).toBeTruthy()
    const pane = document.querySelector('.pane') as HTMLElement
    expect(pane.classList.contains('pane--output-hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Show Output' }))
    expect(pane.classList.contains('pane--output-hidden')).toBe(false)
    expect(screen.getByRole('button', { name: 'Hide Output' })).toBeTruthy()
  })
})

describe('a pane restored after relaunch', () => {
  // "Resume" under "No conversation to resume" started a fresh agent.
  it('says there was nothing to resume and offers New Session first, and Resume… only for a chosen conversation', () => {
    const pane = { agent: 'claude', running: false, exitCode: 0, restored: 'stopped' } as const
    mount(terminal('t1', { ...pane, stoppedFor: 'no-conversation' }))
    expect(marker()).toBe('Nothing to resume · 11:04')
    expect(actions()).toEqual(['New Session', 'Resume…', 'Close'])
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
    fireEvent.click(screen.getByRole('button', { name: 'Resume…' }))
    expect(onResumeConversation).toHaveBeenCalledExactlyOnceWith('t1')
    fireEvent.keyDown(screen.getByTestId('surface-t1'), { key: 'Enter' })
    expect(onRelaunch).toHaveBeenLastCalledWith('t1', { fresh: true })
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  // Two boundaries said it twice: "Task done · not resumed" in the record and "Restored" under it.
  it('says a done task once, with New Session and Close', () => {
    mount(
      terminal('t1', { agent: 'claude', running: false, exitCode: 0, restored: 'stopped', stoppedFor: 'task-done' })
    )
    expect(marker()).toBe('Task done · 11:04')
    expect(actions()).toEqual(['New Session', 'Close'])
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

  it('says what its report says once at rest, never the `msg done` call', () => {
    useWorkspaceStore.setState({ worktrees: [worktree({ outcome: 'succeeded', summary: 'Fixed. Tests pass.' })] })
    mount(terminal('t1', { agent: 'claude', agentEvent: { event: 'Stop', at: 1 } }))
    expect(document.querySelector('.pane-foot')?.textContent).toBe('Ready · Fixed. Tests pass.')
  })

  it('reads failed in the footer, in red, when its report says it failed', () => {
    useWorkspaceStore.setState({ worktrees: [worktree({ outcome: 'failed', summary: 'Migration failed.' })] })
    mount(terminal('t1', { agent: 'claude', agentEvent: { event: 'Stop', at: 1 } }))
    const foot = document.querySelector('.pane-foot') as HTMLElement
    expect(foot.textContent).toBe('Failed · Migration failed.')
    expect(foot.querySelector('.status--failed')).not.toBeNull()
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
    // The card says what it asks; the foot only names the state, so the ask is not said twice.
    expect(document.querySelector('.pane-foot')?.textContent).toBe('Asking')
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

// #529: the question and its answers where the keyboard lands, not only in the sidebar.
describe('an agent asking in its pane', () => {
  const put = {
    id: 7,
    projectId: 'p1',
    kind: 'ask' as const,
    from: { worktreeId: 'w1', terminalId: 't1' },
    to: { you: true as const },
    text: 'Which store for the limiter?',
    options: ['redis', 'postgres'],
    at: 1,
    state: 'queued' as const
  }

  afterEach(() => useMessageStore.setState({ messages: [] }))

  it('quotes a question put to it with its options and Reply…, and no Review', () => {
    const answer = vi.fn(async () => true)
    useMessageStore.setState({ messages: [put], answer })
    mount(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true }))
    const card = document.querySelector('.pane-state--asking') as HTMLElement
    expect(within(card).getByText('Which store for the limiter?')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Review' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'redis' }))
    expect(answer).toHaveBeenCalledWith(put, 'redis')
    fireEvent.click(within(card).getByRole('button', { name: 'Reply…' }))
    fireEvent.change(within(card).getByRole('textbox', { name: 'Answer' }), { target: { value: 'sqlite' } })
    fireEvent.submit(within(card).getByRole('textbox', { name: 'Answer' }))
    expect(answer).toHaveBeenLastCalledWith(put, 'sqlite')
  })

  it('offers Allow for a menu on its screen, and Review only when it has no answer to offer', () => {
    mount(
      terminal('t1', {
        agent: 'claude',
        agentEvent: { event: 'Notification', at: 1, message: 'Claude needs your permission to use Bash' },
        screenMenu: { prompt: 'p', choices: [{ label: 'Yes', keys: ['1'] }] }
      })
    )
    const card = screen.getByRole('group', { name: 'Permission needed' })
    expect(within(card).getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Review' })).toBeNull()
  })

  it('hands its first answer the focus when the keyboard lands on the pane', () => {
    useMessageStore.setState({ messages: [put] })
    mount(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true }))
    expect(focusAskAnswer('t1')).toBe(true)
    expect(document.activeElement?.textContent).toBe('redis')
    expect(focusAskAnswer('elsewhere')).toBe(false)
  })

  it('still draws the question once the pane’s first resize has answered with its record', () => {
    useMessageStore.setState({ messages: [{ ...put, text: 'Ship it?', options: ['Yes', 'No'] }] })
    const asking = terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true })
    useWorkspaceStore.setState({ terminals: { t1: { ...asking, askingYou: undefined } } })
    useWorkspaceStore.getState().recordTerminal({ ...asking, cols: 120, rows: 40 })
    mount(useWorkspaceStore.getState().terminals.t1 as Terminal)
    const card = screen.getByRole('group', { name: 'Needs you' })
    expect(within(card).getByText('Ship it?')).toBeTruthy()
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Yes', 'No', 'Reply…'])
  })

  it('closes Reply on Escape and gives the keyboard to the first answer', () => {
    useMessageStore.setState({ messages: [put] })
    mount(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Answer' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Answer' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'redis' }))
  })

  // #567: the card goes with its answer, and the keyboard goes back to the pane rather than to the page.
  describe('once answered', () => {
    const input = (): Element | null => screen.getByRole('textbox', { name: 'input t1' })

    it('gives the keyboard back to the pane’s terminal after an option', async () => {
      useMessageStore.setState({ messages: [put], answer: vi.fn(async () => true) })
      mount(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true }))
      const redis = screen.getByRole('button', { name: 'redis' })
      redis.focus()
      await act(async () => fireEvent.click(redis))
      expect(document.activeElement).toBe(input())
    })

    it('and after a reply', async () => {
      useMessageStore.setState({ messages: [put], answer: vi.fn(async () => true) })
      mount(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true }))
      fireEvent.click(screen.getByRole('button', { name: 'Reply…' }))
      const field = screen.getByRole('textbox', { name: 'Answer' })
      fireEvent.change(field, { target: { value: 'sqlite' } })
      await act(async () => fireEvent.submit(field))
      expect(document.activeElement).toBe(input())
    })

    it('and after Allow, when the card goes with the keyboard in it', async () => {
      const { answerPane } = useWorkspaceStore.getState()
      useWorkspaceStore.setState({ answerPane: vi.fn(async () => {}) })
      const asking = terminal('t1', {
        agent: 'claude',
        tookTurn: true,
        agentEvent: { event: 'Notification', at: 1, message: 'Claude needs your permission to use Bash' },
        screenMenu: { prompt: 'p', choices: [{ label: 'Yes', keys: ['1'] }] }
      })
      const redraw = mount(asking)
      const allow = screen.getByRole('button', { name: 'Allow' })
      allow.focus()
      fireEvent.click(allow)
      await act(async () => redraw({ ...asking, busy: true, screenMenu: undefined, agentEvent: undefined }))
      expect(document.querySelector('.pane-state--asking')).toBeNull()
      expect(document.activeElement).toBe(input())
      useWorkspaceStore.setState({ answerPane })
    })

    it('finds the panes when its own has gone', async () => {
      useMessageStore.setState({ messages: [put] })
      const drawn = render(tree(terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true })))
      screen.getByRole('button', { name: 'redis' }).focus()
      await act(async () =>
        drawn.rerender(
          <div data-region="panes">
            <section className="pane pane--focused">
              <textarea className="xterm-helper-textarea" aria-label="input t2" />
            </section>
          </div>
        )
      )
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'input t2' }))
    })

    it('leaves the keyboard alone when it was elsewhere', async () => {
      const asking = terminal('t1', { agent: 'claude', askingYou: 7, tookTurn: true })
      useMessageStore.setState({ messages: [put] })
      const redraw = mount(asking)
      const outside = document.body.appendChild(document.createElement('button'))
      outside.focus()
      await act(async () => redraw({ ...asking, askingYou: undefined }))
      expect(document.activeElement).toBe(outside)
      outside.remove()
    })
  })
})
