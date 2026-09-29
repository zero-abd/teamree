// Keeps many streaming panes cheap: output and scrollbar work once per frame,
// a pane's WebGL context held only while it is mounted, and a resize painted in its own frame.

import { WebglAddon } from '@xterm/addon-webgl'
import type { IDisposable, Terminal as XTerm } from '@xterm/xterm'

/** requestAnimationFrame and its cancel, injectable for tests. */
export type FrameClock = { request: (callback: () => void) => number; cancel: (id: number) => void }

const ANIMATION_FRAMES: FrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id)
}

/** Past this much held output it is written at once: a hidden window gets no frames. */
const MAX_HELD_CHARS = 256 * 1024

/** At most one `write` a frame: output after a quiet frame goes straight through, the rest
 * waits for the next frame, joined. `flush` writes what is held now. */
export function frameWrites(
  write: (data: string) => void,
  clock: FrameClock = ANIMATION_FRAMES,
  maxHeld = MAX_HELD_CHARS
): { push: (data: string) => void; flush: () => void; dispose: () => void } {
  let held: string[] = []
  let size = 0
  let frame = 0
  let disposed = false
  const flush = (): void => {
    if (held.length === 0) return
    const data = held.join('')
    held = []
    size = 0
    write(data)
  }
  const onFrame = (): void => {
    frame = 0
    if (held.length === 0) return
    flush()
    frame = clock.request(onFrame)
  }
  return {
    push: (data) => {
      if (disposed) return
      if (!frame) {
        write(data)
        frame = clock.request(onFrame)
        return
      }
      held.push(data)
      size += data.length
      if (size >= maxHeld) flush()
    },
    flush,
    dispose: () => {
      disposed = true
      if (frame) clock.cancel(frame)
      frame = 0
      held = []
    }
  }
}

type Viewport = { _sync: (...args: unknown[]) => void }

/** Moves xterm's scrollbar update, and its fade-timer reset, from every scrolled line to once
 * a frame. Reaches into xterm; a version without the same viewport is left alone. */
export function syncScrollbarPerFrame(term: XTerm, clock: FrameClock = ANIMATION_FRAMES): IDisposable {
  const viewport = (term as unknown as { _core?: { _viewport?: Viewport } })._core?._viewport
  if (typeof viewport?._sync !== 'function') return { dispose: () => {} }
  const sync = viewport._sync.bind(viewport)
  let frame = 0
  // Only the per-line call passes no argument; xterm's own queued sync passes one and stays immediate.
  viewport._sync = (...args: unknown[]) => {
    if (args.length > 0) {
      sync(...args)
      return
    }
    if (frame) return
    frame = clock.request(() => {
      frame = 0
      sync()
    })
  }
  return {
    dispose: () => {
      if (frame) clock.cancel(frame)
      frame = 0
      viewport._sync = sync
    }
  }
}

type RenderQueue = { _animationFrame?: number; _innerRefresh: () => void }

/** Calls `changed` whenever `target` changes size; injectable for tests. */
export type SizeWatch = (target: Element, changed: () => void) => IDisposable

const DEVICE_PIXELS: SizeWatch = (target, changed) => {
  const observer = new ResizeObserver(() => changed())
  observer.observe(target, { box: 'device-pixel-content-box' })
  return { dispose: () => observer.disconnect() }
}

/** Paints what the emulator queued for the next frame whenever its WebGL `canvas` changes size, so a resize
 * never shows a blank pane. Reaches into xterm. */
export function paintResizesNow(term: object, canvas: Element, watch: SizeWatch = DEVICE_PIXELS): IDisposable {
  const core = (term as { _core?: { _renderService?: { _renderDebouncer?: RenderQueue } } })._core
  // Each resize wipes the canvas, then xterm's device-pixel correction wipes it again, and both queue the
  // repaint for the next frame: the frame being drawn would go to the screen empty.
  return watch(canvas, () => {
    const queue = core?._renderService?._renderDebouncer
    if (typeof queue?._innerRefresh !== 'function' || queue._animationFrame === undefined) return
    cancelAnimationFrame(queue._animationFrame)
    queue._innerRefresh()
  })
}

type LoseContext = { loseContext: () => void }
type WithContext = {
  _renderer?: { _gl?: { getExtension: (name: string) => LoseContext | null }; _canvas?: HTMLCanvasElement }
}

const NOTHING: IDisposable = { dispose: () => {} }

/** The pane's WebGL renderer: a lost context falls back to the DOM renderer until `retry`.
 * `dispose` frees the context now; Chrome caps live contexts and evicts the oldest. */
export function paneWebgl(
  term: Pick<XTerm, 'loadAddon'>,
  create: () => WebglAddon = () => new WebglAddon(),
  watch?: SizeWatch
): { retry: () => void; dispose: () => void } {
  let addon: WebglAddon | null = null
  let painting = NOTHING
  let lost = false
  const load = (): void => {
    let next: WebglAddon | null = null
    try {
      next = create()
      const mine = next
      mine.onContextLoss(() => {
        if (addon !== mine) return
        addon = null
        lost = true
        painting.dispose()
        mine.dispose()
      })
      term.loadAddon(mine)
      addon = mine
      // Made after the addon's own observer, on every load, so it runs after that observer's correction.
      const canvas = (mine as unknown as WithContext)._renderer?._canvas
      painting = canvas === undefined ? NOTHING : paintResizesNow(term, canvas, watch)
    } catch {
      // No working context on this machine: the DOM renderer stays.
      next?.dispose()
    }
  }
  load()
  return {
    retry: () => {
      if (!lost || addon) return
      lost = false
      load()
    },
    dispose: () => {
      const current = addon
      addon = null
      painting.dispose()
      if (!current) return
      const context = (current as unknown as WithContext)._renderer?._gl
      current.dispose()
      context?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
