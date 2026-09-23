import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Rect = { x: number; y: number; width: number; height: number }

/** Where the window was left: its normal bounds, plus the modes laid over them. */
export type WindowState = { bounds: Rect; maximized: boolean; fullScreen: boolean }

export const DEFAULT_WINDOW_SIZE = { width: 1400, height: 900 } as const
const MIN_WINDOW_SIZE = { width: 800, height: 560 } as const
export const WINDOW_STATE_FILE = 'window-state.json'
export const SAVE_DEBOUNCE_MS = 500

/** Less than this on every display in either direction counts as lost off screen. */
const MIN_VISIBLE_PX = 64

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  }
}

function centredDefault(primary: Rect): Rect {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, primary.width)
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, primary.height)
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height
  }
}

/** The state to open with: the saved one, or centred on the primary display when it is no longer on any. */
export function placeWindow(saved: WindowState | null, workAreas: readonly Rect[], primary: Rect): WindowState {
  if (!saved) return { bounds: centredDefault(primary), maximized: false, fullScreen: false }
  const visible = workAreas.some((area) => {
    const shared = overlap(saved.bounds, area)
    return shared.width >= MIN_VISIBLE_PX && shared.height >= MIN_VISIBLE_PX
  })
  return visible ? saved : { ...saved, bounds: centredDefault(primary) }
}

/** The window's minimum size, shrunk to a work area smaller than it so the first window still fits. */
export function minimumSize(primary: Rect): { minWidth: number; minHeight: number } {
  return {
    minWidth: Math.min(MIN_WINDOW_SIZE.width, primary.width),
    minHeight: Math.min(MIN_WINDOW_SIZE.height, primary.height)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The state, rebuilt field by field, or null. */
export function readWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const { bounds, maximized, fullScreen } = value as Record<string, unknown>
  if (typeof maximized !== 'boolean' || typeof fullScreen !== 'boolean') return null
  if (typeof bounds !== 'object' || bounds === null) return null
  const { x, y, width, height } = bounds as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width < 1 || height < 1) return null
  const rounded = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  return { bounds: rounded, maximized, fullScreen }
}

/** Null for a first launch or a file that is not a state. */
export function loadWindowState(file: string): WindowState | null {
  try {
    return readWindowState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** Synchronous so the save on close lands before the process exits. A failed write only warns. */
export function saveWindowState(file: string, state: WindowState): void {
  const temp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(state)}\n`)
    renameSync(temp, file)
  } catch (error) {
    console.warn('[window-state]', error)
  }
}

const CHANGES = ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const

/** A BrowserWindow, reduced to what the tracker reads. */
export type TrackedWindow = {
  // Method syntax: BrowserWindow's per-event overloads only match a bivariant signature.
  on(event: (typeof CHANGES)[number] | 'close', listener: () => void): unknown
  getNormalBounds: () => Rect
  isMaximized: () => boolean
  isFullScreen: () => boolean
  isVisible: () => boolean
  isDestroyed: () => boolean
}

/** Saves the window's state once each burst of changes settles, and at once when it closes. */
export function trackWindowState(
  window: TrackedWindow,
  opened: WindowState,
  save: (state: WindowState) => void,
  debounceMs = SAVE_DEBOUNCE_MS
): void {
  let modes = { maximized: opened.maximized, fullScreen: opened.fullScreen }
  let pending: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    clearTimeout(pending)
    pending = undefined
    if (window.isDestroyed()) return
    // A hidden window (background launch, minimised) never had its modes applied, so keep the last seen.
    if (window.isVisible()) modes = { maximized: window.isMaximized(), fullScreen: window.isFullScreen() }
    save({ bounds: window.getNormalBounds(), ...modes })
  }

  for (const change of CHANGES) {
    window.on(change, () => {
      clearTimeout(pending)
      pending = setTimeout(flush, debounceMs)
    })
  }
  window.on('close', flush)
}
