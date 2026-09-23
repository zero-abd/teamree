/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { frameWrites, paneWebgl, syncScrollbarPerFrame, type FrameClock } from './paneFrames'

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

/** A stand-in for the WebGL addon: its context, and the loss it can be told to report. */
function fakeAddon(log: string[], name: string) {
  let onLoss: (() => void) | null = null
  const gl = {
    getExtension: (extension: string) =>
      extension === 'WEBGL_lose_context' ? { loseContext: () => log.push(`${name} context released`) } : null
  }
  return {
    addon: {
      _renderer: { _gl: gl },
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
    const made: ReturnType<typeof fakeAddon>[] = []
    const term = { loadAddon: vi.fn() }
    const create = vi.fn(() => {
      const fake = fakeAddon(log, `addon ${made.length + 1}`)
      made.push(fake)
      return fake.addon as never
    })
    const gpu = paneWebgl(term as never, create)
    return { log, made, term, create, gpu }
  }

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
