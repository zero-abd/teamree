import { describe, expect, it } from 'vitest'
import {
  bringForward,
  revealLaunchWindow,
  watchActivation,
  type ActivationEvents,
  type LaunchWindow
} from './launchReveal'

function fakeApp(): ActivationEvents & { emit: (event: string) => void } {
  const listeners: { event: string; listener: () => void; once: boolean }[] = []
  return {
    on: (event: string, listener: () => void) => listeners.push({ event, listener, once: false }),
    once: (event: string, listener: () => void) => listeners.push({ event, listener, once: true }),
    emit: (event) => {
      for (const entry of [...listeners]) {
        if (entry.event !== event) continue
        if (entry.once) listeners.splice(listeners.indexOf(entry), 1)
        entry.listener()
      }
    }
  }
}

function fakeWindow(): LaunchWindow & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    maximize: () => calls.push('maximize'),
    setFullScreen: (flag) => calls.push(`setFullScreen:${flag}`),
    isDestroyed: () => false
  }
}

const plain = { maximized: false, fullScreen: false }

describe('watchActivation', () => {
  it('follows whether macOS has the app active', () => {
    const app = fakeApp()
    const activated = watchActivation(app)
    expect(activated()).toBe(false)
    app.emit('did-become-active')
    expect(activated()).toBe(true)
    app.emit('did-resign-active')
    expect(activated()).toBe(false)
  })
})

describe('revealLaunchWindow', () => {
  it('shows and fronts the window when macOS activated the launch', () => {
    const app = fakeApp()
    const window = fakeWindow()
    revealLaunchWindow(
      window,
      { maximized: true, fullScreen: true },
      { platform: 'darwin', activated: () => true, app }
    )
    expect(window.calls).toEqual(['maximize', 'show', 'setFullScreen:true'])
  })

  it('never activates the app after `open -g`: shown inactive, never with show', () => {
    const app = fakeApp()
    const window = fakeWindow()
    revealLaunchWindow(
      window,
      { maximized: true, fullScreen: false },
      { platform: 'darwin', activated: () => false, app }
    )
    expect(window.calls).toEqual(['maximize', 'showInactive'])
  })

  it('holds a restored full screen until the person brings the app forward', () => {
    const app = fakeApp()
    const window = fakeWindow()
    revealLaunchWindow(
      window,
      { maximized: false, fullScreen: true },
      { platform: 'darwin', activated: () => false, app }
    )
    expect(window.calls).toEqual([])
    app.emit('did-become-active')
    app.emit('did-become-active')
    expect(window.calls).toEqual(['show', 'setFullScreen:true'])
  })

  it('shows normally where there is no activation to wait for', () => {
    const window = fakeWindow()
    revealLaunchWindow(window, plain, { platform: 'win32', activated: () => false, app: fakeApp() })
    expect(window.calls).toEqual(['show'])
  })
})

describe('bringForward', () => {
  it('shows a window still held back for full screen before focusing it', () => {
    const calls: string[] = []
    const window = {
      isMinimized: () => false,
      restore: () => calls.push('restore'),
      isVisible: () => false,
      show: () => calls.push('show'),
      focus: () => calls.push('focus')
    }
    bringForward(window)
    expect(calls).toEqual(['show', 'focus'])
  })
})
