import { describe, expect, it } from 'vitest'
import { macEditBytes, type EditKey } from './macEditKeys'

function key(name: string, held: Partial<Omit<EditKey, 'key'>> = {}): EditKey {
  return { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held }
}

describe('macEditBytes', () => {
  it.each([
    ['⇧↩', key('Enter', { shiftKey: true }), '\u001b\r'],
    ['⌘←', key('ArrowLeft', { metaKey: true }), '\u0001'],
    ['⌘→', key('ArrowRight', { metaKey: true }), '\u0005'],
    ['⌘⌫', key('Backspace', { metaKey: true }), '\u0015'],
    ['⌘⌦', key('Delete', { metaKey: true }), '\u000b'],
    ['⌥←', key('ArrowLeft', { altKey: true }), '\u001bb'],
    ['⌥→', key('ArrowRight', { altKey: true }), '\u001bf']
  ])('%s sends its bytes', (_name, event, bytes) => {
    expect(macEditBytes(event, false)).toBe(bytes)
  })

  it.each([
    ['↩', key('Enter')],
    ['⌘↩', key('Enter', { metaKey: true })],
    ['⌘⇧↩', key('Enter', { metaKey: true, shiftKey: true })],
    ['⌥↩', key('Enter', { altKey: true })],
    ['⌃↩', key('Enter', { ctrlKey: true })],
    ['⌥⌫', key('Backspace', { altKey: true })],
    ['⌘⇧←', key('ArrowLeft', { metaKey: true, shiftKey: true })],
    ['⌘⌥←', key('ArrowLeft', { metaKey: true, altKey: true })],
    ['⌃←', key('ArrowLeft', { ctrlKey: true })],
    ['⌥⇧←', key('ArrowLeft', { altKey: true, shiftKey: true })],
    ['←', key('ArrowLeft')],
    ['⌘C', key('c', { metaKey: true })],
    ['⌘V', key('v', { metaKey: true })],
    ['⌘A', key('a', { metaKey: true })],
    ['⌘K', key('k', { metaKey: true })],
    ['⇧↩ mid-composition', key('Enter', { shiftKey: true, isComposing: true })]
  ])('%s is left to the emulator', (_name, event) => {
    expect(macEditBytes(event, false)).toBeNull()
  })

  it('leaves ⌥←/⌥→ to the emulator when Option is Meta', () => {
    expect(macEditBytes(key('ArrowLeft', { altKey: true }), true)).toBeNull()
    expect(macEditBytes(key('ArrowRight', { altKey: true }), true)).toBeNull()
    expect(macEditBytes(key('ArrowLeft', { metaKey: true }), true)).toBe('\u0001')
  })
})
