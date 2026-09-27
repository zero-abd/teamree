/** @vitest-environment jsdom */

// Settings › Appearance draws each theme from its own tokens and redraws as the mode, a preset or the accent is
// picked; a preview that stood still would be a picture, not a preview.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCENT_PRESETS,
  BUILT_IN_THEMES,
  DEFAULT_APPEARANCE,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  resolvePalette,
  themeById,
  themeTone,
  withChoice,
  type Appearance,
  type BuiltInTheme
} from '@shared/theme'

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
const { ThemeGroup, accentName } = await import('./AppearancePage')

const INITIAL = useWorkspaceStore.getState()
// Writes through to the store, so the page redraws the way it does in the app.
const setAppearance = vi.fn(async (appearance: Appearance) => useWorkspaceStore.setState({ appearance }))
const showAppearance = vi.fn()

const DARK: Appearance = { ...DEFAULT_APPEARANCE, mode: 'dark' }
const featured = themeById(DEFAULT_THEME_ID).name
const featuredLight = themeById(DEFAULT_LIGHT_THEME_ID).name
const otherDark = BUILT_IN_THEMES.find(
  (theme) => theme.id !== DEFAULT_THEME_ID && themeTone(theme.id) === 'dark'
) as BuiltInTheme
const otherLight = BUILT_IN_THEMES.find(
  (theme) => theme.id !== DEFAULT_LIGHT_THEME_ID && themeTone(theme.id) === 'light'
) as BuiltInTheme
const sky = ACCENT_PRESETS.find((preset) => preset.name === 'Sky') as { name: string; value: string }

function seed(appearance: Appearance = DARK): void {
  useWorkspaceStore.setState({ ...INITIAL, appearance, systemTone: 'dark', setAppearance, showAppearance }, true)
}

const card = (name: string): HTMLElement => {
  const found = screen.getAllByRole('button', { name }).find((button) => button.matches('.theme-card, .theme-preset'))
  expect(found, name).toBeDefined()
  return found as HTMLElement
}
const preview = (name: string): HTMLElement => within(card(name)).getByTestId('theme-preview')
const token = (name: string, property: string): string => preview(name).style.getPropertyValue(`--${property}`)

beforeEach(() => {
  setAppearance.mockClear()
  showAppearance.mockClear()
  seed()
})

afterEach(cleanup)

describe('the theme previews', () => {
  it('draws each theme from its own tokens, not the window’s', () => {
    render(<ThemeGroup />)
    for (const theme of [themeById(DEFAULT_THEME_ID), otherDark]) {
      const palette = resolvePalette(withChoice(DARK, 'dark', { ...DARK, themeId: theme.id }), 'dark')
      expect(token(theme.name, 'bg-pane')).toBe(palette['bg-pane'])
      expect(token(theme.name, 'accent')).toBe(palette.accent)
    }
    const light = resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'light' }, 'light')
    expect(token(featuredLight, 'bg-rail')).toBe(light['bg-rail'])
  })

  it('marks the theme on screen and the one each mode would use', () => {
    render(<ThemeGroup />)
    expect(card(featured).getAttribute('aria-pressed')).toBe('true')
    expect(card(featured).hasAttribute('data-on-screen')).toBe(true)
    expect(card(featuredLight).getAttribute('aria-pressed')).toBe('true')
    expect(card(featuredLight).hasAttribute('data-on-screen')).toBe(false)
    expect(card(otherDark.name).getAttribute('aria-pressed')).toBe('false')
  })

  it('redraws the theme on screen in a picked accent', () => {
    render(<ThemeGroup />)
    fireEvent.click(screen.getByRole('button', { name: 'Sky' }))
    expect(setAppearance).toHaveBeenCalledOnce()
    expect(token(featured, 'accent')).toBe(sky.value)
    expect(screen.getByRole('button', { name: 'Sky' }).getAttribute('aria-pressed')).toBe('true')
    expect(accentName(useWorkspaceStore.getState().appearance, 'dark')).toBe('Sky')
  })

  it('moves the window to a picked mode, and the mark with it', () => {
    render(<ThemeGroup />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Mode' })).getByRole('button', { name: 'Light' }))
    expect(useWorkspaceStore.getState().appearance.mode).toBe('light')
    expect(card(featuredLight).hasAttribute('data-on-screen')).toBe(true)
    expect(card(featured).hasAttribute('data-on-screen')).toBe(false)
  })

  it('takes a preset fresh, and a light one in dark mode takes the window to light', () => {
    seed({ ...DARK, accent: sky.value })
    render(<ThemeGroup />)
    fireEvent.click(card(otherDark.name))
    expect(useWorkspaceStore.getState().appearance).toMatchObject({ themeId: otherDark.id, accent: null })
    expect(card(otherDark.name).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(card(otherLight.name))
    expect(useWorkspaceStore.getState().appearance).toMatchObject({ mode: 'light', light: { themeId: otherLight.id } })
  })

  it('keeps the edits of the theme already chosen when it is picked again', () => {
    seed({ ...DARK, accent: sky.value })
    render(<ThemeGroup />)
    fireEvent.click(card(featured))
    expect(setAppearance).not.toHaveBeenCalled()
  })

  it('names a theme’s own accent after the nearest preset, and one picked elsewhere Custom', () => {
    expect(accentName({ ...DEFAULT_APPEARANCE, mode: 'light' }, 'light')).toBe(
      accentName({ ...DEFAULT_APPEARANCE, mode: 'dark' }, 'dark')
    )
    expect(accentName({ ...DARK, accent: '#123456' }, 'dark')).toBe('Custom')
  })

  it('opens the colour editor from Customize…', () => {
    render(<ThemeGroup />)
    fireEvent.click(screen.getByRole('button', { name: 'Customize…' }))
    expect(showAppearance).toHaveBeenCalledExactlyOnceWith(true)
  })
})
