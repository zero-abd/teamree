/** @vitest-environment jsdom */

// The dialog that stands between a click and a killed process.
//
// Its wording is decided in `closePaneModel` and asserted there. What is only
// true of the assembled dialog is here: that the two buttons do opposite things
// and that the safe one is the one offered first; that going through calls the
// close that skips the question rather than the one that asks it again; and
// that a question whose answer has stopped mattering takes itself away instead
// of waiting to be pressed through.

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { ConfirmClosePaneDialog } = await import('./ConfirmClosePaneDialog')

const INITIAL = useWorkspaceStore.getState()
const closeDialog = vi.fn()
const forceCloseTerminal = vi.fn()

const terminal = (overrides: Partial<Terminal> = {}): Terminal => ({
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
  lastOutputAt: 0,
  ...overrides
})

function seed(record: Terminal | undefined): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      terminals: record === undefined ? {} : { t1: record },
      dialog: { kind: 'confirm-close-pane', terminalId: 't1' },
      closeDialog,
      forceCloseTerminal
    },
    true
  )
}

const mount = (): void => {
  render(<ConfirmClosePaneDialog terminalId="t1" />)
}

beforeEach(() => {
  closeDialog.mockReset()
  forceCloseTerminal.mockReset()
})

describe('answering it', () => {
  it('says what is running, and offers leaving it alone first', () => {
    seed(terminal())
    mount()
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Stop this agent?')
    expect(screen.getByText(/claude is working/)).toBeTruthy()

    // The order is the argument: the button that changes nothing is the one a
    // hand lands on first, and the one that kills a process is the one that has
    // to be reached for.
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons.indexOf('Leave it open')).toBeLessThan(buttons.indexOf('Stop it and close'))
  })

  it('leaves the pane alone when the answer is no', () => {
    seed(terminal())
    mount()
    act(() => screen.getByRole('button', { name: 'Leave it open' }).click())
    expect(forceCloseTerminal).not.toHaveBeenCalled()
    expect(closeDialog).toHaveBeenCalled()
  })

  // Through `forceCloseTerminal` and never `closeTerminal`: the latter is the
  // one that raises this dialog, so going through it here would put the same
  // question straight back on the screen and close nothing, forever.
  it('closes the pane through the path that does not ask again', () => {
    seed(terminal())
    mount()
    act(() => screen.getByRole('button', { name: 'Stop it and close' }).click())
    expect(forceCloseTerminal).toHaveBeenCalledWith('t1')
  })
})

describe('a question that has stopped mattering', () => {
  // An agent answering, a build finishing, or the pane being closed from
  // somewhere else while this is open. Holding somebody at a dialog about work
  // that is no longer running teaches them the dialog is noise.
  it('takes itself away when the pane stops working', () => {
    seed(terminal())
    const { rerender } = render(<ConfirmClosePaneDialog terminalId="t1" />)
    expect(screen.queryByRole('dialog')).toBeTruthy()

    act(() => {
      useWorkspaceStore.setState({ terminals: { t1: terminal({ busy: false, running: false }) } })
    })
    rerender(<ConfirmClosePaneDialog terminalId="t1" />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closeDialog).toHaveBeenCalled()
    expect(forceCloseTerminal).not.toHaveBeenCalled()
  })

  it('shows nothing for a pane the window no longer has', () => {
    seed(undefined)
    mount()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
