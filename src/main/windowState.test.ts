import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WINDOW_SIZE,
  loadWindowState,
  placeWindow,
  readWindowState,
  saveWindowState,
  trackWindowState,
  type Rect,
  type WindowState
} from './windowState'

const LAPTOP: Rect = { x: 0, y: 25, width: 1512, height: 920 }
const MONITOR_RIGHT: Rect = { x: 1512, y: 0, width: 2560, height: 1415 }

function state(bounds: Rect, modes: Partial<WindowState> = {}): WindowState {
  return { bounds, maximized: false, fullScreen: false, ...modes }
}

const CENTRED_ON_LAPTOP: Rect = {
  x: Math.round((LAPTOP.width - DEFAULT_WINDOW_SIZE.width) / 2),
  y: LAPTOP.y + Math.round((LAPTOP.height - DEFAULT_WINDOW_SIZE.height) / 2),
  ...DEFAULT_WINDOW_SIZE
}

describe('placing the window at launch', () => {
  it('opens centred at the default size on a first launch', () => {
    expect(placeWindow(null, [LAPTOP], LAPTOP)).toEqual(state(CENTRED_ON_LAPTOP))
  })

  it('reopens where it was left', () => {
    const saved = state({ x: 2000, y: 100, width: 1600, height: 1000 }, { maximized: true })
    expect(placeWindow(saved, [LAPTOP, MONITOR_RIGHT], LAPTOP)).toEqual(saved)
  })

  it('falls back to the primary display once the monitor it was on is unplugged', () => {
    const saved = state({ x: 2000, y: 100, width: 1600, height: 1000 }, { fullScreen: true })
    expect(placeWindow(saved, [LAPTOP], LAPTOP)).toEqual(state(CENTRED_ON_LAPTOP, { fullScreen: true }))
  })

  it('falls back when only a sliver would still be on screen', () => {
    const saved = state({ x: LAPTOP.width - 10, y: 100, width: 1200, height: 800 })
    expect(placeWindow(saved, [LAPTOP], LAPTOP).bounds).toEqual(CENTRED_ON_LAPTOP)
  })

  it('keeps a window that hangs partly off one edge', () => {
    const saved = state({ x: -400, y: 200, width: 1200, height: 800 })
    expect(placeWindow(saved, [LAPTOP], LAPTOP)).toEqual(saved)
  })

  it('fits the default into a primary display smaller than it', () => {
    const small: Rect = { x: 0, y: 25, width: 1280, height: 775 }
    expect(placeWindow(null, [small], small).bounds).toEqual({ x: 0, y: 25, width: 1280, height: 775 })
  })
})

describe('reading a saved state', () => {
  it('rebuilds a well-formed one', () => {
    const saved = state({ x: 10.4, y: -20, width: 1200, height: 800 }, { maximized: true })
    expect(readWindowState(saved)).toEqual(state({ x: 10, y: -20, width: 1200, height: 800 }, { maximized: true }))
  })

  it.each([
    null,
    'window',
    { bounds: { x: 0, y: 0, width: 0, height: 800 }, maximized: false, fullScreen: false },
    { bounds: { x: Number.NaN, y: 0, width: 900, height: 800 }, maximized: false, fullScreen: false },
    { bounds: { x: 0, y: 0, width: 900, height: 800 }, maximized: 'yes', fullScreen: false },
    { maximized: false, fullScreen: false }
  ])('rejects %j', (value) => {
    expect(readWindowState(value)).toBeNull()
  })
})

describe('the file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamree-window-state-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips', () => {
    const file = join(dir, 'nested', 'window-state.json')
    const saved = state({ x: 1, y: 2, width: 900, height: 700 }, { fullScreen: true })
    saveWindowState(file, saved)
    expect(loadWindowState(file)).toEqual(saved)
  })

  it('reads as nothing when missing or corrupt', () => {
    const file = join(dir, 'window-state.json')
    expect(loadWindowState(file)).toBeNull()
    writeFileSync(file, '{"bounds":')
    expect(loadWindowState(file)).toBeNull()
  })
})

/** A BrowserWindow reduced to what the tracker reads. */
class FakeWindow extends EventEmitter {
  bounds: Rect = { x: 100, y: 100, width: 1400, height: 900 }
  maximized = false
  fullScreen = false
  visible = true
  destroyed = false
  getNormalBounds = (): Rect => ({ ...this.bounds })
  isMaximized = (): boolean => this.maximized
  isFullScreen = (): boolean => this.fullScreen
  isVisible = (): boolean => this.visible
  isDestroyed = (): boolean => this.destroyed
}

describe('tracking the window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves once after a burst of moves and resizes settles', () => {
    const window = new FakeWindow()
    const save = vi.fn()
    trackWindowState(window, state(window.bounds), save, 300)

    window.bounds = { x: 120, y: 110, width: 1300, height: 850 }
    window.emit('move')
    window.emit('resize')
    vi.advanceTimersByTime(299)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledExactlyOnceWith(state({ x: 120, y: 110, width: 1300, height: 850 }))
  })

  it('saves at once when the window closes, and not again after', () => {
    const window = new FakeWindow()
    const save = vi.fn()
    trackWindowState(window, state(window.bounds), save, 300)

    window.fullScreen = true
    window.emit('enter-full-screen')
    window.emit('close')
    expect(save).toHaveBeenCalledExactlyOnceWith(state(window.bounds, { fullScreen: true }))
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps the modes it last saw while the window is hidden', () => {
    const window = new FakeWindow()
    const save = vi.fn()
    trackWindowState(window, state(window.bounds, { maximized: true }), save, 300)

    window.visible = false
    window.emit('close')
    expect(save).toHaveBeenCalledWith(state(window.bounds, { maximized: true }))
  })

  it('does not read a destroyed window', () => {
    const window = new FakeWindow()
    const save = vi.fn()
    trackWindowState(window, state(window.bounds), save, 300)

    window.emit('resize')
    window.destroyed = true
    vi.advanceTimersByTime(300)
    expect(save).not.toHaveBeenCalled()
  })
})
