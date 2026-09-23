import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, resolvePalette, type Appearance } from '../shared/theme'
import { installNativeAppearance, windowBackground } from './nativeAppearance'

/** `nativeTheme` as macOS drives it: `themeSource` overrides the OS, `updated` fires on any change. */
function fakeNativeTheme(osDark: boolean) {
  const listeners: (() => void)[] = []
  const theme = {
    themeSource: 'system' as 'system' | 'light' | 'dark',
    osDark,
    get shouldUseDarkColors(): boolean {
      return theme.themeSource === 'system' ? theme.osDark : theme.themeSource === 'dark'
    },
    on: (_event: 'updated', listener: () => void) => listeners.push(listener),
    flipOs(dark: boolean) {
      theme.osDark = dark
      for (const listener of listeners) listener()
    }
  }
  return theme
}

function fakeWindow() {
  const painted: string[] = []
  return { painted, setBackgroundColor: (color: string) => painted.push(color) }
}

const LIGHT_GROUND = resolvePalette(DEFAULT_APPEARANCE, 'light')['bg-window']
const DARK_GROUND = resolvePalette(DEFAULT_APPEARANCE, 'dark')['bg-window']

describe('the native appearance', () => {
  it('opens a light window on a light Mac under Match System, so there is no dark flash', () => {
    const nativeTheme = fakeNativeTheme(false)
    installNativeAppearance({ nativeTheme, appearance: () => DEFAULT_APPEARANCE, windows: () => [] })
    expect(nativeTheme.themeSource).toBe('system')
    expect(windowBackground(DEFAULT_APPEARANCE, nativeTheme)).toBe(LIGHT_GROUND)
  })

  it('points the OS appearance at an explicit choice', () => {
    const nativeTheme = fakeNativeTheme(false)
    const window = fakeWindow()
    const follow = installNativeAppearance({
      nativeTheme,
      appearance: () => DEFAULT_APPEARANCE,
      windows: () => [window]
    })

    const dark: Appearance = { ...DEFAULT_APPEARANCE, mode: 'dark' }
    follow(dark)
    expect(nativeTheme.themeSource).toBe('dark')
    expect(window.painted.at(-1)).toBe(DARK_GROUND)
  })

  it('repaints every window when the Mac switches', () => {
    const nativeTheme = fakeNativeTheme(true)
    const window = fakeWindow()
    installNativeAppearance({ nativeTheme, appearance: () => DEFAULT_APPEARANCE, windows: () => [window] })
    nativeTheme.flipOs(false)
    expect(window.painted.at(-1)).toBe(LIGHT_GROUND)
    nativeTheme.flipOs(true)
    expect(window.painted.at(-1)).toBe(DARK_GROUND)
  })

  it('leaves a window stored before modes existed dark on a light Mac', () => {
    const nativeTheme = fakeNativeTheme(false)
    const stored: Appearance = { themeId: 'graphite', ground: null, accent: null, overrides: {} }
    installNativeAppearance({ nativeTheme, appearance: () => stored, windows: () => [] })
    expect(nativeTheme.themeSource).toBe('dark')
  })
})
