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
