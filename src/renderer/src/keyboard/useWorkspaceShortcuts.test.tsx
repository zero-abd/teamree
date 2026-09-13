/** @vitest-environment jsdom */

// Which pane a chord acts on.
//
// The window's key handler is the one place where "the focused pane" has to
// mean both kinds of pane at once: your own, whose focus is a field in a layout
// the runtime keeps, and a teammate's, whose focus is a field in this window
// because the runtime has never heard of it. Close is the chord where getting
// that wrong is worst — the two closes are `terminal.close` on this machine and
// dropping a subscription to somebody else's — so it is the one asserted here.

import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const { resolvePlatformModifier } = await import('./platformModifier')
const { useWorkspaceShortcuts } = await import('./useWorkspaceShortcuts')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

const closeTerminal = vi.fn()
const closeWatchedPane = vi.fn()

function Harness(): null {
  useWorkspaceShortcuts(MAC)
  return null
}

function seed(overrides: Record<string, unknown>): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      closeTerminal,
      closeWatchedPane,
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      ...overrides
    },
    true
  )
  render(<Harness />)
}

/** The close chord, on macOS, where the whole app runs. */
const pressClose = (): void => {
  fireEvent.keyDown(window, { key: 'w', metaKey: true })
}

beforeEach(() => {
  closeTerminal.mockReset()
  closeWatchedPane.mockReset()
})

describe('the close chord', () => {
  it('closes the pane of your own that has the focus', () => {
    seed({})
    pressClose()
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t1')
    expect(closeWatchedPane).not.toHaveBeenCalled()
  })

  // Closing a teammate's pane is the whole of stopping the watch: the pane is
  // the subscription, and nothing flows once it is gone.
  it('stops the watch when the focused pane is a teammate’s, and leaves yours alone', () => {
    seed({ focusedWatchId: 'watch:p1:priya:t7' })
    pressClose()
    expect(closeWatchedPane).toHaveBeenCalledExactlyOnceWith('watch:p1:priya:t7')
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})
