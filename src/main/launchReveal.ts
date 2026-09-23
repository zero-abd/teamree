import type { BrowserWindow } from 'electron'

export interface ActivationEvents {
  on(event: 'did-become-active', listener: () => void): unknown
  on(event: 'did-resign-active', listener: () => void): unknown
  once(event: 'did-become-active', listener: () => void): unknown
}

export type LaunchWindow = Pick<BrowserWindow, 'show' | 'showInactive' | 'maximize' | 'setFullScreen' | 'isDestroyed'>

/** Whether the app is active now; `open -g` and login items launch it inactive. */
export function watchActivation(app: ActivationEvents): () => boolean {
  let active = false
  app.on('did-become-active', () => (active = true))
  app.on('did-resign-active', () => (active = false))
  return () => active
}

/** Shows the first window, fronting the app only when macOS activated the launch. */
export function revealLaunchWindow(
  window: LaunchWindow,
  opened: { maximized: boolean; fullScreen: boolean },
  launch: { platform: NodeJS.Platform; activated: () => boolean; app: ActivationEvents }
): void {
  if (opened.maximized) window.maximize()
  if (launch.platform !== 'darwin' || launch.activated()) {
    window.show()
    if (opened.fullScreen) window.setFullScreen(true)
    return
  }
  // On macOS `show` activates the app and a full-screen window takes over a Space, so both wait for the
  // person. The full-screen one stays hidden till then, which also keeps windowState.ts from saving it windowed.
  if (!opened.fullScreen) {
    window.showInactive()
    return
  }
  launch.app.once('did-become-active', () => {
    if (window.isDestroyed()) return
    window.show()
    window.setFullScreen(true)
  })
}

/** Fronts the window for a second launch; one held back for full screen is hidden, which `focus` skips. */
export function bringForward(
  window: Pick<BrowserWindow, 'isMinimized' | 'restore' | 'isVisible' | 'show' | 'focus'>
): void {
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}
