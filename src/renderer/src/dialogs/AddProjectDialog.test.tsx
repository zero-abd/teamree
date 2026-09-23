/** @vitest-environment jsdom */

// Adding a repository, and the one thing the dialog must not do on its own.
//
// It used to call the native folder picker from a mount effect, so the OS
// sheet was up before the dialog had been read — over a path field with a real
// placeholder and a Browse button that were both there to be used. A sheet
// nobody asked for is also what makes the dialog undriveable from a hidden
// window, which is a fair proxy for undriveable from a test.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { AddProjectDialog } = await import('./AddProjectDialog')

const selectProjectFolder = vi.fn<() => Promise<string | null>>()

beforeEach(() => {
  selectProjectFolder.mockReset()
  selectProjectFolder.mockResolvedValue('/Users/ada/code/atlas')
  ;(window as unknown as { teamree: unknown }).teamree = { selectProjectFolder }
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('the folder picker', () => {
  it('waits to be asked for', () => {
    render(<AddProjectDialog />)
    expect(selectProjectFolder).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Repository path' })).toBeTruthy()
  })

  it('opens from the button, and fills the path with what was chosen', async () => {
    render(<AddProjectDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(selectProjectFolder).toHaveBeenCalledOnce()
    const path = screen.getByRole('textbox', { name: 'Repository path' }) as HTMLInputElement
    await vi.waitFor(() => expect(path.value).toBe('/Users/ada/code/atlas'))
  })
})
