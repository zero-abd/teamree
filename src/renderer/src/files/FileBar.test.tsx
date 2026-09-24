/** @vitest-environment jsdom */

// A zoomed file pane's bar carries the way back to the layout.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

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
const { FileBar } = await import('./FileBar')

const INITIAL = useWorkspaceStore.getState()
const toggleExpandedPane = vi.fn()

beforeEach(() => {
  toggleExpandedPane.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, toggleExpandedPane }, true)
})

const mount = (): void => {
  render(<FileBar name="math.ts" label="src/math.ts" title="src/math.ts" unsaved={false} tabbed onClose={() => {}} />)
}

it('offers Restore at its right end while zoomed, and restores', () => {
  useWorkspaceStore.setState({ expandedTerminalId: 'file:1' })
  mount()
  const buttons = [...document.querySelectorAll('.file__bar button')]
  const restore = screen.getByRole('button', { name: 'Restore layout' })
  expect(buttons.at(-1)).toBe(restore)
  fireEvent.click(restore)
  expect(toggleExpandedPane).toHaveBeenCalledOnce()
})

it('offers nothing of the kind in the layout', () => {
  mount()
  expect(screen.queryByRole('button', { name: 'Restore layout' })).toBeNull()
})
