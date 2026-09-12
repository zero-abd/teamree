import { describe, expect, it } from 'vitest'
import { SCROLLBACK_CAP_BYTES, ScrollbackBuffer } from './scrollback'

describe('ScrollbackBuffer', () => {
  it('returns everything written while under the cap', () => {
    const buffer = new ScrollbackBuffer(1024)
    buffer.append('first ')
    buffer.append('second')
    expect(buffer.tail()).toBe('first second')
    expect(buffer.byteLength).toBe(12)
  })

  it('returns only the requested tail', () => {
    const buffer = new ScrollbackBuffer(1024)
    buffer.append('abcdefghij')
    expect(buffer.tail(4)).toBe('ghij')
    expect(buffer.tail(100)).toBe('abcdefghij')
  })

  it('never exceeds the cap however chatty the process is', () => {
    const cap = 1024
    const buffer = new ScrollbackBuffer(cap)
    for (let i = 0; i < 500; i++) buffer.append(`line ${i}\n`)

    expect(buffer.byteLength).toBeLessThanOrEqual(cap)
    const tail = buffer.tail()
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(cap)
    expect(tail.endsWith('line 499\n')).toBe(true)
    expect(tail).not.toContain('line 0\n')
  })

  it('keeps the tail of a single write larger than the whole buffer', () => {
    const buffer = new ScrollbackBuffer(64)
    buffer.append('x'.repeat(500) + 'END')
    expect(buffer.byteLength).toBe(64)
    expect(buffer.tail().endsWith('END')).toBe(true)
  })

  it('does not start a tail mid-character when the cut lands inside one', () => {
    // Four 3-byte characters in a 10-byte buffer: the cut falls inside one.
    const buffer = new ScrollbackBuffer(10)
    buffer.append('。。。。')
    expect(buffer.tail()).toBe('。。。')
    expect(buffer.tail()).not.toContain('�')
  })

  it('clears', () => {
    const buffer = new ScrollbackBuffer(64)
    buffer.append('gone')
    buffer.clear()
    expect(buffer.byteLength).toBe(0)
    expect(buffer.tail()).toBe('')
  })

  it('defaults to a multi-megabyte cap', () => {
    expect(new ScrollbackBuffer().capacity).toBe(SCROLLBACK_CAP_BYTES)
    expect(SCROLLBACK_CAP_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
  })
})
