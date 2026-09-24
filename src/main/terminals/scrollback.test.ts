import { describe, expect, it } from 'vitest'
import { evidenceLine } from '../../shared/outputEvidence'
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

  it('does not start a tail inside an escape sequence the cut split', () => {
    const buffer = new ScrollbackBuffer(1024)
    const colour = '\x1b[38;2;138;138;138;49m'
    buffer.append(`older\r\n${colour}• Ran the tests\x1b[0m\r\n\x1b[1mdone\x1b[0m`)
    const whole = Buffer.byteLength(buffer.tail(), 'utf8')
    const intoColour = Buffer.byteLength(`older\r\n\x1b[38;2;1`, 'utf8')

    const tail = buffer.tail(whole - intoColour)
    expect(tail).not.toContain('38;')
    expect(tail.startsWith('\x1b[')).toBe(true)
    expect(evidenceLine(tail)).toBe('done')
  })

  it('does not start a whole read inside an escape sequence eviction split', () => {
    const buffer = new ScrollbackBuffer(24)
    buffer.append('\x1b[38;2;138;138;138;49m•\x1b[0m\r\nlast')
    expect(buffer.tail()).not.toContain(';49m')
    expect(buffer.tail().endsWith('last')).toBe(true)
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
