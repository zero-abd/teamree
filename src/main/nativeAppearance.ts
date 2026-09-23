// Keeps macOS's own appearance (menus, scrollbars, the renderer's `prefers-color-scheme`) and each
// window's backdrop in step with the chosen mode, so a resize or a launch never shows the other tone.

import { resolvePalette, type Appearance } from '../shared/theme'

type NativeTheme = {
  themeSource: 'system' | 'light' | 'dark'
  readonly shouldUseDarkColors: boolean
  on: (event: 'updated', listener: () => void) => unknown
}

type Backdrop = { setBackgroundColor: (color: string) => void }

/** The ground the window opens on; `themeSource` must already be set. */
export function windowBackground(
  appearance: Appearance,
  nativeTheme: Pick<NativeTheme, 'shouldUseDarkColors'>
): string {
  return resolvePalette(appearance, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')['bg-window']
}

/** Applies the current appearance and returns the function that applies each later one. */
export function installNativeAppearance(deps: {
  nativeTheme: NativeTheme
  appearance: () => Appearance
  windows: () => readonly Backdrop[]
}): (appearance: Appearance) => void {
  const { nativeTheme } = deps
  const paint = (appearance: Appearance): void => {
    const color = windowBackground(appearance, nativeTheme)
    for (const window of deps.windows()) window.setBackgroundColor(color)
  }
  const follow = (appearance: Appearance): void => {
    nativeTheme.themeSource = appearance.mode ?? 'dark'
    paint(appearance)
  }
  nativeTheme.on('updated', () => paint(deps.appearance()))
  follow(deps.appearance())
  return follow
}
