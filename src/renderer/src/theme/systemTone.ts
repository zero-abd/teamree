// The tone `prefers-color-scheme` reports. Main sets `nativeTheme.themeSource` from the chosen mode,
// so under Match System this is the Mac's own appearance and it changes live.

import type { Tone } from '@shared/theme'

const DARK_SCHEME = '(prefers-color-scheme: dark)'

export function readSystemTone(): Tone {
  if (typeof matchMedia !== 'function') return 'dark'
  return matchMedia(DARK_SCHEME).matches ? 'dark' : 'light'
}

/** Calls `onChange` on every switch; returns the stop function. */
export function watchSystemTone(onChange: (tone: Tone) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const query = matchMedia(DARK_SCHEME)
  const listener = (event: { matches: boolean }): void => onChange(event.matches ? 'dark' : 'light')
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
