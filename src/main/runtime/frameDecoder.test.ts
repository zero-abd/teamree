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
  // `buffer += chunk` builds a rope and every `indexOf` flattens it, so 52MB of
  // newline-free input took 18 seconds of a pegged main thread.
  it('costs about the same for fifty megabytes as for one', () => {
    const chunk = 'x'.repeat(64 * 1024)
    const once = (megabytes: number): number => {
      const decode = createFrameDecoder(1024 * 1024 * 1024)
      const pushes = Math.round((megabytes * 1024 * 1024) / chunk.length)
      const started = performance.now()
      for (let index = 0; index < pushes; index += 1) decode(chunk)
      return performance.now() - started
    }

    // A minimum rather than an average: an average moves with the load.
    const fastest = (megabytes: number): number => {
      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 5; attempt += 1) best = Math.min(best, once(megabytes))
      return best
    }

    const small = fastest(4)
    const large = fastest(32)

    // Eight times the input: linear lands near eight, quadratic near sixty-four.
    expect(large / Math.max(small, 0.05)).toBeLessThan(24)
  })

  it('gives up rather than buffering without end', () => {
    const decode = createFrameDecoder(1024)

    expect(() => decode('x'.repeat(2048))).toThrow(/without completing/)
  })

  // A reader that resynchronised mid-stream could be made to parse the sender's choice of boundary.
  it('keeps nothing of the frame it refused', () => {
    const decode = createFrameDecoder(1024)
    expect(() => decode('x'.repeat(2048))).toThrow()

    expect(decode('{"ok":true}\n')).toEqual([{ ok: true }])
  })
})
