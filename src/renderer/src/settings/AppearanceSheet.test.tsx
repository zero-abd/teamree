/** @vitest-environment jsdom */

// Appearance beside the panes it colours: no scrim, no blur, the window live around it.

import { fireEvent, render, screen, within } from '@testing-library/react'
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
const { AppearanceSheet } = await import('./AppearanceSheet')

const INITIAL = useWorkspaceStore.getState()
const showAppearance = vi.fn()

beforeEach(() => {
  showAppearance.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, appearanceOpen: true, showAppearance }, true)
})

describe('the appearance sheet', () => {
  it('holds the mode, theme and accent controls in a named region, not a dialog', () => {
    render(<AppearanceSheet />)
    const sheet = screen.getByRole('complementary', { name: 'Appearance' })
    expect(within(sheet).getByRole('radiogroup', { name: 'Mode' })).toBeTruthy()
    expect(within(sheet).getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Violet' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.modal-layer, .modal__scrim')).toBeNull()
  })

  it('takes the focus when it opens, so Tab starts inside it', () => {
    render(<AppearanceSheet />)
    expect(document.activeElement).toBe(screen.getByRole('complementary', { name: 'Appearance' }))
  })

  it('closes on its ×, and on Escape pressed inside it', () => {
    render(<AppearanceSheet />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Appearance' }))
    expect(showAppearance).toHaveBeenLastCalledWith(false)
    showAppearance.mockReset()
    fireEvent.keyDown(screen.getByRole('radio', { name: /Midnight/ }), { key: 'Escape' })
    expect(showAppearance).toHaveBeenCalledExactlyOnceWith(false)
  })

  // A pane beside it is live, and Escape there belongs to the program in it.
  it('leaves Escape pressed outside it alone', () => {
    render(
      <>
        <textarea aria-label="pane" />
        <AppearanceSheet />
      </>
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'pane' }), { key: 'Escape' })
    expect(showAppearance).not.toHaveBeenCalled()
  })
})
