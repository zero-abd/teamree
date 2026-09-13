// Framing is the one place a bug corrupts every method at once, so the decoder
// is exercised against the chunk shapes a real socket produces.

import { describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame, isStreamEvent, type Frame } from '../../shared/protocol'

describe('frame decoder', () => {
  it('yields nothing until a line is complete', () => {
    const decode = createFrameDecoder()

    expect(decode('{"id":"1",')).toEqual([])
    expect(decode('"ok":true,')).toEqual([])
    expect(decode('"result":7}\n')).toEqual([{ id: '1', ok: true, result: 7 }])
  })

  it('yields every value in a multi-line chunk', () => {
    const decode = createFrameDecoder()
    const chunk = ['a', 'b', 'c'].map((id) => encodeFrame({ id, ok: true, result: id })).join('')

    expect(decode(chunk).map((frame) => (frame as { id: string }).id)).toEqual(['a', 'b', 'c'])
  })

  it('carries a partial tail into the next chunk', () => {
    const decode = createFrameDecoder()
    const wire = encodeFrame({ id: '1', ok: true, result: 'x' }) + encodeFrame({ stream: 's1', event: 'tick' })
    const split = wire.indexOf('\n') + 5

    const first = decode(wire.slice(0, split))
    const second = decode(wire.slice(split))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(isStreamEvent(second[0] as Frame)).toBe(true)
  })

  it('survives byte-at-a-time delivery', () => {
    const decode = createFrameDecoder()
    const wire = encodeFrame({ stream: 's1', event: { type: 'data', data: 'héllo\twörld' } })

    const decoded = [...wire].flatMap((character) => decode(character))

    expect(decoded).toEqual([{ stream: 's1', event: { type: 'data', data: 'héllo\twörld' } }])
  })

  it('ignores blank lines and throws on a corrupt one', () => {
    const decode = createFrameDecoder()

    expect(decode('\n\n')).toEqual([])
    expect(() => decode('not json\n')).toThrow()
  })
})

describe('a sender that never completes a frame', () => {
  // The reason this exists: `buffer += chunk` builds a rope, and every
  // `indexOf` on it flattens the whole rope — so newline-free input cost the
  // accumulated length again on every chunk. 52MB of it took 18 seconds of a
  // pegged main thread, which owns every PTY and the window's IPC, and any
  // member of the roster could send it.
  it('costs about the same for fifty megabytes as for one', () => {
    const chunk = 'x'.repeat(64 * 1024)
    const time = (megabytes: number): number => {
      const decode = createFrameDecoder(1024 * 1024 * 1024)
      const pushes = Math.round((megabytes * 1024 * 1024) / chunk.length)
      const started = performance.now()
      for (let index = 0; index < pushes; index += 1) decode(chunk)
      return performance.now() - started
    }

    const small = time(4)
    const large = time(32)

    // Eight times the input for well under eight times the work. Quadratic
    // would be sixty-four; the bound is loose because a test asserting a
    // constant factor on shared hardware is a test that fails for the weather.
    expect(large).toBeLessThan(Math.max(small, 1) * 16)
  })

  it('gives up rather than buffering without end', () => {
    const decode = createFrameDecoder(1024)

    expect(() => decode('x'.repeat(2048))).toThrow(/without completing/)
  })

  // Half a frame is not a frame: a reader that resynchronised mid-stream could
  // be made to parse the sender's choice of boundary.
  it('keeps nothing of the frame it refused', () => {
    const decode = createFrameDecoder(1024)
    expect(() => decode('x'.repeat(2048))).toThrow()

    expect(decode('{"ok":true}\n')).toEqual([{ ok: true }])
  })
})
