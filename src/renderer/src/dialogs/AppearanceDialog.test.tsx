/** @vitest-environment jsdom */

// The dialog that has no Save button.
//
// Everything below is about that being a deliberate design rather than a gap:
// a press on a preset is the choice made, an edit to one colour is that colour
// changed, and the only way back is the Reset that says what it puts back. If
// any of these stopped writing through, the dialog would look identical and do
// nothing — which is the failure this file exists to catch.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE, type Appearance, type Tone } from '@shared/theme'

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
const { AppearanceDialog } = await import('./AppearanceDialog')

const INITIAL = useWorkspaceStore.getState()

const closeDialog = vi.fn()
const setAppearance = vi.fn()

function seed(appearance: Appearance = DEFAULT_APPEARANCE, systemTone: Tone = 'dark'): void {
  useWorkspaceStore.setState(
    { ...INITIAL, dialog: { kind: 'appearance' }, appearance, systemTone, closeDialog, setAppearance },
    true
  )
}

/** The appearance the last press asked for. */
function lastChange(): Appearance {
  const call = setAppearance.mock.calls.at(-1)
  expect(call, 'nothing was written through').toBeDefined()
  return (call as [Appearance])[0]
}

beforeEach(() => {
  closeDialog.mockReset()
  setAppearance.mockReset()
  seed()
})

describe('picking a theme', () => {
  it('offers the built-ins with absolute black already chosen', () => {
    render(<AppearanceDialog />)
    expect(screen.getByRole('radio', { name: /Absolute Black/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: /Midnight/ }).getAttribute('aria-checked')).toBe('false')
  })

  it('writes the choice through on the press, with no save to forget', () => {
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('radio', { name: /Midnight/ }))
    expect(lastChange().themeId).toBe('midnight')
  })

  // A preset is a fresh start rather than a layer. Carrying edits across a
  // switch would hand somebody a theme that is neither of the two they picked.
  it('drops the edits made against the theme being left', () => {
    seed({ themeId: 'black', ground: '#101010', accent: '#ff00ff', overrides: { line: '#333333' } })
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('radio', { name: /Graphite/ }))
    expect(lastChange()).toEqual({ themeId: 'graphite', ground: null, accent: null, overrides: {} })
  })
})

describe('the two choices worth making without opening anything', () => {
  it('sets an accent from the row of them', () => {
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Amber' }))
    expect(lastChange().accent).toBe('#e0a13e')
  })

  it('sets a ground, which is what every surface above it is rebuilt from', () => {
    render(<AppearanceDialog />)
    fireEvent.change(screen.getByLabelText('Ground'), { target: { value: '#101820' } })
    expect(lastChange().ground).toBe('#101820')
  })

  it('offers a way back to the preset’s ground once one has been chosen', () => {
    seed({ ...DEFAULT_APPEARANCE, ground: '#101820' })
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: /Back to Absolute Black/ }))
    expect(lastChange().ground).toBeNull()
  })
})

describe('editing a colour directly', () => {
  it('keeps the list shut until it is asked for', () => {
    render(<AppearanceDialog />)
    expect(screen.queryByLabelText('Hairline')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Every colour/ }))
    expect(screen.getByLabelText('Hairline')).toBeTruthy()
  })

  it('records one token without touching the others', () => {
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: /Every colour/ }))
    fireEvent.change(screen.getByLabelText('Hairline'), { target: { value: '#445566' } })
    expect(lastChange().overrides).toEqual({ line: '#445566' })
  })

  it('takes one back out again, rather than writing the preset’s value over it', () => {
    seed({ ...DEFAULT_APPEARANCE, overrides: { line: '#445566', fg: '#ffffff' } })
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: /1 changed|2 changed|Every colour/ }))
    // Two rows carry an Undo, and the first in document order is the text one:
    // the groups are listed surfaces, lines, text, so `--line` comes first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0] as HTMLElement)
    expect(lastChange().overrides).toEqual({ fg: '#ffffff' })
  })
})

describe('getting back', () => {
  it('offers no reset when there is nothing to reset', () => {
    render(<AppearanceDialog />)
    expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true)
  })

  it('puts the whole preset back in one press', () => {
    seed({ themeId: 'midnight', ground: '#101820', accent: '#ff00ff', overrides: { line: '#333333' } })
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(lastChange()).toEqual({ themeId: 'midnight', ground: null, accent: null, overrides: {} })
  })
})

describe('light, dark, or whatever the Mac is', () => {
  it('offers the three, with Match System chosen on a new installation', () => {
    render(<AppearanceDialog />)
    expect(mode('Match System').getAttribute('aria-checked')).toBe('true')
    expect(mode('Light').getAttribute('aria-checked')).toBe('false')
    expect(mode('Dark').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the mode through and keeps both slots', () => {
    seed({ ...DEFAULT_APPEARANCE, themeId: 'midnight' })
    render(<AppearanceDialog />)
    fireEvent.click(mode('Light'))
    expect(lastChange()).toMatchObject({ mode: 'light', themeId: 'midnight' })
  })

  it('offers the light presets while the window is light', () => {
    seed(DEFAULT_APPEARANCE, 'light')
    render(<AppearanceDialog />)
    expect(preset('Light').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radio', { name: /Absolute Black/ })).toBeNull()
    fireEvent.click(preset('Paper'))
    expect(lastChange()).toMatchObject({ themeId: 'black', light: { themeId: 'paper' } })
  })

  it('edits the light slot while light, and leaves the dark one alone', () => {
    seed({ ...DEFAULT_APPEARANCE, mode: 'light', themeId: 'graphite' })
    render(<AppearanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Amber' }))
    expect(lastChange()).toMatchObject({ themeId: 'graphite', accent: null, light: { accent: '#e0a13e' } })
  })
})

function mode(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name })
}

function preset(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name })
}
