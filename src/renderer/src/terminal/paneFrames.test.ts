/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  frameWrites,
  paintResizesNow,
  paneWebgl,
  syncScrollbarPerFrame,
  type FrameClock,
  type SizeWatch
} from './paneFrames'

/** A frame clock the test advances by hand. */
function manualClock(): FrameClock & { tick: () => void; queued: () => number } {
  let next = 1
  const callbacks = new Map<number, () => void>()
  return {
    request: (callback) => {
      const id = next++
      callbacks.set(id, callback)
      return id
    },
    cancel: (id) => void callbacks.delete(id),
    tick: () => {
      const due = [...callbacks.values()]
      callbacks.clear()
      for (const callback of due) callback()
    },
    queued: () => callbacks.size
  }
}

describe('frameWrites', () => {
  it('hands the emulator at most one write per frame, in arrival order', () => {
    const clock = manualClock()
    const write = vi.fn()
    const writes = frameWrites(write, clock)
    writes.push('a')
    writes.push('b')
    writes.push('c')
    expect(write.mock.calls).toEqual([['a']])
    clock.tick()
    expect(write.mock.calls).toEqual([['a'], ['bc']])
    writes.push('d')
    writes.push('e')
    expect(write).toHaveBeenCalledTimes(2)
    clock.tick()
    expect(write.mock.calls.at(-1)).toEqual(['de'])
  })

  // A keystroke's echo is the first output in its frame, so typing waits for no frame.
  it('writes output that arrives after a quiet frame straight away', () => {
    const clock = manualClock()
    const write = vi.fn()
    const writes = frameWrites(write, clock)
    writes.push('a')
    clock.tick()
    clock.tick()
    expect(clock.queued()).toBe(0)
    writes.push('b')
    expect(write.mock.calls).toEqual([['a'], ['b']])
  })

  it('writes what is waiting before anything that must follow it', () => {
    const clock = manualClock()
    const write = vi.fn()
    const writes = frameWrites(write, clock)
    writes.push('first')
    writes.push('output')
    writes.flush()
    write('[exit]')
    clock.tick()
    expect(write.mock.calls).toEqual([['first'], ['output'], ['[exit]']])
  })

  it('does not hold more than a bounded amount while frames are not coming', () => {
    const clock = manualClock()
    const write = vi.fn()
    const writes = frameWrites(write, clock, 8)
    writes.push('0')
    writes.push('12345')
    expect(write).toHaveBeenCalledTimes(1)
    writes.push('6789')
    expect(write.mock.calls).toEqual([['0'], ['123456789']])
  })

  it('writes nothing after it is disposed', () => {
    const clock = manualClock()
    const write = vi.fn()
    const writes = frameWrites(write, clock)
    writes.push('now')
    writes.push('late')
    writes.dispose()
    clock.tick()
    writes.push('later')
    clock.tick()
    expect(write.mock.calls).toEqual([['now']])
  })
})

type Scrollbar = { setScrollDimensions: (...args: unknown[]) => void }

function openTerm(): { term: XTerm; scrollbar: Scrollbar; write: (data: string) => Promise<void> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 40, rows: 5, scrollback: 1000 })
  term.open(host)
  const scrollbar = (term as unknown as { _core: { _viewport: { _scrollableElement: Scrollbar } } })._core._viewport
    ._scrollableElement
  return { term, scrollbar, write: (data) => new Promise((resolve) => term.write(data, resolve)) }
}

const lines = (count: number): string => Array.from({ length: count }, (_, line) => `line ${line}\r\n`).join('')

describe('syncScrollbarPerFrame', () => {
  it('without it, the scrollbar is updated once for every line that scrolls', async () => {
    const { term, scrollbar, write } = openTerm()
    const sync = vi.spyOn(scrollbar, 'setScrollDimensions')
    await write(lines(200))
    expect(sync.mock.calls.length).toBeGreaterThan(150)
    term.dispose()
  })

  it('updates the scrollbar once a frame however many lines scrolled', async () => {
    const { term, scrollbar, write } = openTerm()
    const clock = manualClock()
    const stop = syncScrollbarPerFrame(term, clock)
    const sync = vi.spyOn(scrollbar, 'setScrollDimensions')
    await write(lines(200))
    expect(sync).not.toHaveBeenCalled()
    clock.tick()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    stop.dispose()
    term.dispose()
  })

  it('leaves no frame behind once disposed', async () => {
    const { term, write } = openTerm()
    const clock = manualClock()
    const stop = syncScrollbarPerFrame(term, clock)
    await write(lines(20))
    expect(clock.queued()).toBe(1)
    stop.dispose()
    expect(clock.queued()).toBe(0)
    term.dispose()
  })

  it('does nothing to an emulator without the viewport it expects', () => {
    expect(() => syncScrollbarPerFrame({} as XTerm, manualClock()).dispose()).not.toThrow()
  })
})

type RenderService = {
  _renderer: { value: { dimensions: unknown } }
  setRenderer: (renderer: unknown) => void
}

type Canvas = { painted: string[]; draws: () => number; correct: () => void }

/** Paints the way the WebGL renderer does: a resize wipes the canvas and only a render puts rows back;
 * `correct` is its device-pixel correction, which wipes it again and asks for a repaint. */
function canvasRenderer(term: XTerm): Canvas {
  const service = (term as unknown as { _core: { _renderService: RenderService } })._core._renderService
  const painted: string[] = []
  let draws = 0
  let redraw: ((rows: { start: number; end: number }) => void) | null = null
  const none = (): void => {}
  service.setRenderer({
    dimensions: service._renderer.value.dimensions,
    onRequestRedraw: (listener: typeof redraw) => {
      redraw = listener
      return { dispose: none }
    },
    handleResize: () => void painted.splice(0),
    renderRows: (start: number, end: number) => {
      draws += 1
      const buffer = term.buffer.active
      for (let row = start; row <= end; row++) {
        painted[row] = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
      }
    },
    dispose: none,
    handleDevicePixelRatioChange: none,
    handleCharSizeChanged: none,
    handleBlur: none,
    handleFocus: none,
    handleSelectionChanged: none,
    handleCursorMove: none,
    clear: none
  })
  return {
    painted,
    draws: () => draws,
    correct: () => {
      painted.splice(0)
      redraw?.({ start: 0, end: term.rows - 1 })
    }
  }
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** A frame with a pane's fit in it: the resize in its animation frame, then the size observers in the
 * order they were made. Reads the canvas as that frame goes to the screen. */
function resizeInFrame(term: XTerm, canvas: Canvas, rows: number, laterObservers: () => void): Promise<string[]> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      term.resize(40, rows)
      queueMicrotask(() => {
        canvas.correct()
        laterObservers()
        resolve([...canvas.painted])
      })
    })
  )
}

/** A size watch the test fires by hand. */
function handWatch(): { watch: SizeWatch; fire: () => void; watching: () => number } {
  const changed = new Set<() => void>()
  return {
    watch: (_target, callback) => {
      changed.add(callback)
      return { dispose: () => void changed.delete(callback) }
    },
    fire: () => changed.forEach((callback) => callback()),
    watching: () => changed.size
  }
}

describe('paintResizesNow', () => {
  it('without it, the frame a resize lands in goes to the screen blank', async () => {
    const { term, write } = openTerm()
    const canvas = canvasRenderer(term)
    await write('one\r\ntwo')
    await nextFrame()
    expect(canvas.painted.slice(0, 2)).toEqual(['one', 'two'])
    expect(await resizeInFrame(term, canvas, 8, () => {})).toEqual([])
    term.dispose()
  })

  it('paints every row of the new size in the frame of the resize, once', async () => {
    const { term, write } = openTerm()
    const canvas = canvasRenderer(term)
    const sizes = handWatch()
    const painting = paintResizesNow(term, document.createElement('canvas'), sizes.watch)
    await write('one\r\ntwo')
    await nextFrame()
    const before = canvas.draws()
    expect(await resizeInFrame(term, canvas, 8, sizes.fire)).toEqual(['one', 'two', '', '', '', '', '', ''])
    await nextFrame()
    expect(canvas.draws()).toBe(before + 1)
    painting.dispose()
    expect(await resizeInFrame(term, canvas, 6, sizes.fire)).toEqual([])
    term.dispose()
  })

  it('does nothing to an emulator without the render queue it expects', () => {
    const sizes = handWatch()
    paintResizesNow({}, document.createElement('canvas'), sizes.watch)
    expect(() => sizes.fire()).not.toThrow()
  })
})

/** A stand-in for the WebGL addon: its context, and the loss it can be told to report. */
function fakeAddon(log: string[], name: string) {
  let onLoss: (() => void) | null = null
  const gl = {
    getExtension: (extension: string) =>
      extension === 'WEBGL_lose_context' ? { loseContext: () => log.push(`${name} context released`) } : null
  }
  return {
    addon: {
      _renderer: { _gl: gl, _canvas: document.createElement('canvas') },
      onContextLoss: (listener: () => void) => {
        onLoss = listener
        return { dispose: () => {} }
      },
      dispose: () => log.push(`${name} disposed`),
      activate: () => {}
    },
    lose: () => onLoss?.()
  }
}

describe('paneWebgl', () => {
  const setup = () => {
    const log: string[] = []
    const order: string[] = []
    const made: ReturnType<typeof fakeAddon>[] = []
    const term = { loadAddon: vi.fn(() => void order.push(`addon ${made.length} loaded`)) }
    const create = vi.fn(() => {
      const fake = fakeAddon(log, `addon ${made.length + 1}`)
      made.push(fake)
      return fake.addon as never
    })
    const sizes = handWatch()
    const gpu = paneWebgl(term as never, create, (target, changed) => {
      order.push(`watching addon ${made.length}`)
      return sizes.watch(target, changed)
    })
    return { log, order, made, term, create, gpu, sizes }
  }

  it('watches each canvas it loads for size, after the addon, and stops with it', () => {
    const { order, made, gpu, sizes } = setup()
    expect(order).toEqual(['addon 1 loaded', 'watching addon 1'])
    made[0]?.lose()
    expect(sizes.watching()).toBe(0)
    gpu.retry()
    expect(order.slice(-2)).toEqual(['addon 2 loaded', 'watching addon 2'])
    expect(sizes.watching()).toBe(1)
    gpu.dispose()
    expect(sizes.watching()).toBe(0)
  })

  it('releases the context itself on unmount rather than waiting for the collector', () => {
    const { log, gpu } = setup()
    gpu.dispose()
    expect(log).toEqual(['addon 1 disposed', 'addon 1 context released'])
  })

  it('tries WebGL once more at the next chance after the context is lost', () => {
    const { log, made, term, create, gpu } = setup()
    made[0]?.lose()
    expect(log).toEqual(['addon 1 disposed'])
    gpu.retry()
    expect(create).toHaveBeenCalledTimes(2)
    expect(term.loadAddon).toHaveBeenCalledTimes(2)
    gpu.retry()
    expect(create).toHaveBeenCalledTimes(2)
    gpu.dispose()
    expect(log.slice(1)).toEqual(['addon 2 disposed', 'addon 2 context released'])
  })

  it('does not retry a pane whose context was never lost', () => {
    const { create, gpu } = setup()
    gpu.retry()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('stays on the DOM renderer when a context cannot be made', () => {
    const term = { loadAddon: vi.fn() }
    const gpu = paneWebgl(term as never, () => {
      throw new Error('no webgl2')
    })
    expect(() => {
      gpu.retry()
      gpu.dispose()
    }).not.toThrow()
    expect(term.loadAddon).not.toHaveBeenCalled()
  })
})
