/** @vitest-environment jsdom */

// Settings › Appearance has no Save button.
//
// Everything below is about that being a deliberate design rather than a gap:
// a press on a preset is the choice made, an edit to one colour is that colour
// changed, and the only way back is the Reset that says what it puts back. If
// any of these stopped writing through, the section would look identical and do
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
const { AppearanceSettings } = await import('./AppearanceSettings')

const INITIAL = useWorkspaceStore.getState()

const setAppearance = vi.fn()

function seed(appearance: Appearance = DEFAULT_APPEARANCE, systemTone: Tone = 'dark'): void {
  useWorkspaceStore.setState({ ...INITIAL, appearance, systemTone, setAppearance }, true)
}

/** The appearance the last press asked for. */
function lastChange(): Appearance {
  const call = setAppearance.mock.calls.at(-1)
  expect(call, 'nothing was written through').toBeDefined()
  return (call as [Appearance])[0]
}

beforeEach(() => {
  setAppearance.mockReset()
  seed()
})

describe('picking a theme', () => {
  it('offers the built-ins with absolute black already chosen', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('radio', { name: /Absolute Black/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: /Midnight/ }).getAttribute('aria-checked')).toBe('false')
  })

  it('writes the choice through on the press, with no save to forget', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('radio', { name: /Midnight/ }))
    expect(lastChange().themeId).toBe('midnight')
  })

  // A preset is a fresh start rather than a layer. Carrying edits across a
  // switch would hand somebody a theme that is neither of the two they picked.
  it('drops the edits made against the theme being left', () => {
    seed({ themeId: 'black', ground: '#101010', accent: '#ff00ff', overrides: { line: '#333333' } })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('radio', { name: /Graphite/ }))
    expect(lastChange()).toEqual({ themeId: 'graphite', ground: null, accent: null, overrides: {} })
  })
})

describe('the theme cards', () => {
  const preview = (name: RegExp): HTMLElement =>
    screen.getByRole('radio', { name }).querySelector('.appearance__preview') as HTMLElement

  // Four near-black grounds read as four identical tiles; the sidebar, pane and their hairline tell them apart.
  it('draws each dark preset in its own sidebar, pane and accent, so no two look alike', () => {
    render(<AppearanceSettings />)
    const drawn = [/Absolute Black/, /high contrast/, /Midnight/, /Graphite/].map((name) => {
      const tile = preview(name)
      for (const part of ['sidebar', 'pane', 'accent']) {
        expect(tile.querySelector(`.appearance__preview-${part}`), `${String(name)} ${part}`).not.toBeNull()
      }
      return [tile, ...tile.querySelectorAll('*')].map((element) => element.getAttribute('style') ?? '').join('|')
    })
    expect(new Set(drawn).size).toBe(4)
  })
})

describe('the two choices worth making without opening anything', () => {
  it('sets an accent from the row of them', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Pink' }))
    expect(lastChange().accent).toBe('#e070c0')
  })

  it('names the brand accent Violet, and marks it chosen on a new installation', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Indigo' })).toBeNull()
  })

  // Amber is an agent asking, green done, red failed.
  it('offers no accent in a state colour', () => {
    render(<AppearanceSettings />)
    for (const name of ['Amber', 'Lime', 'Rose']) expect(screen.queryByRole('button', { name })).toBeNull()
  })

  // Drawn in the current accent it looked like a second Violet.
  it('draws the custom well as a + until a custom accent is set', () => {
    const custom = (): HTMLElement => screen.getByLabelText('Custom accent').parentElement as HTMLElement
    const view = render(<AppearanceSettings />)
    expect(custom().textContent).toBe('+')
    fireEvent.change(screen.getByLabelText('Custom accent'), { target: { value: '#12a0ff' } })
    expect(lastChange().accent).toBe('#12a0ff')

    view.unmount()
    seed({ ...DEFAULT_APPEARANCE, accent: '#12a0ff' })
    render(<AppearanceSettings />)
    expect(custom().textContent).toBe('')
    expect((screen.getByLabelText('Custom accent') as HTMLInputElement).value).toBe('#12a0ff')
  })

  it('sets a ground, which is what every surface above it is rebuilt from', () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Ground'), { target: { value: '#101820' } })
    expect(lastChange().ground).toBe('#101820')
  })

  it('offers a way back to the preset’s ground once one has been chosen', () => {
    seed({ ...DEFAULT_APPEARANCE, ground: '#101820' })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: /Back to Absolute Black/ }))
    expect(lastChange().ground).toBeNull()
  })
})

describe('editing a colour directly', () => {
  it('keeps the list shut until it is asked for', () => {
    render(<AppearanceSettings />)
    expect(screen.queryByLabelText('Hairline')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All Colours' }))
    expect(screen.getByLabelText('Hairline')).toBeTruthy()
  })

  it('records one token without touching the others', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'All Colours' }))
    fireEvent.change(screen.getByLabelText('Hairline'), { target: { value: '#445566' } })
    expect(lastChange().overrides).toEqual({ line: '#445566' })
  })

  it('takes one back out again, rather than writing the preset’s value over it', () => {
    seed({ ...DEFAULT_APPEARANCE, overrides: { line: '#445566', fg: '#ffffff' } })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: /^All Colours.*2 changed$/ }))
    // Two rows carry an Undo, and the first in document order is the text one:
    // the groups are listed surfaces, lines, text, so `--line` comes first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0] as HTMLElement)
    expect(lastChange().overrides).toEqual({ fg: '#ffffff' })
  })
})

describe('getting back', () => {
  it('offers no reset when there is nothing to reset', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true)
  })

  // The theme's name is on its card; beside Reset it was said twice.
  it('is Reset alone, with no theme name beside it', () => {
    seed({ themeId: 'midnight', ground: null, accent: null, overrides: { line: '#333333' } })
    render(<AppearanceSettings />)
    const footer = screen.getByRole('button', { name: 'Reset' }).parentElement as HTMLElement
    expect(footer.textContent).toBe('Reset')
  })

  it('counts nothing on the colour list until a colour is changed', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('button', { name: 'All Colours' }).textContent).toBe('All Colours')
  })

  it('puts the whole preset back in one press', () => {
    seed({ themeId: 'midnight', ground: '#101820', accent: '#ff00ff', overrides: { line: '#333333' } })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(lastChange()).toEqual({ themeId: 'midnight', ground: null, accent: null, overrides: {} })
  })
})

describe('light, dark, or whatever the Mac is', () => {
  it('offers the three, with Match System chosen on a new installation', () => {
    render(<AppearanceSettings />)
    expect(mode('Match System').getAttribute('aria-checked')).toBe('true')
    expect(mode('Light').getAttribute('aria-checked')).toBe('false')
    expect(mode('Dark').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the mode through and keeps both slots', () => {
    seed({ ...DEFAULT_APPEARANCE, themeId: 'midnight' })
    render(<AppearanceSettings />)
    fireEvent.click(mode('Light'))
    expect(lastChange()).toMatchObject({ mode: 'light', themeId: 'midnight' })
  })

  it('offers the light presets while the window is light', () => {
    seed(DEFAULT_APPEARANCE, 'light')
    render(<AppearanceSettings />)
    expect(preset('Light').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radio', { name: /Absolute Black/ })).toBeNull()
    fireEvent.click(preset('Paper'))
    expect(lastChange()).toMatchObject({ themeId: 'black', light: { themeId: 'paper' } })
  })

  it('edits the light slot while light, and leaves the dark one alone', () => {
    seed({ ...DEFAULT_APPEARANCE, mode: 'light', themeId: 'graphite' })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Pink' }))
    expect(lastChange()).toMatchObject({ themeId: 'graphite', accent: null, light: { accent: '#e070c0' } })
  })
})

function mode(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name })
}

function preset(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name })
}
