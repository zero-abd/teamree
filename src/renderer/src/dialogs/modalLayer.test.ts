// Which question is on screen, and whether anything is.
//
// The second of those looks like a formality and is not. Three surfaces stand
// aside from a modal — the window's key handler and the two cards that speak
// without being asked — and each of them was written while `dialog` was the
// only way a modal could be on screen. A question about a teammate's keystrokes
// is not in `dialog`, so each of those three went on acting as though the
// window were clear: chords fired underneath a prompt that refuses Escape, and
// two cards drew themselves under its scrim.

import { describe, expect, it } from 'vitest'
import type { ConsentRequest } from '@shared/entities'
import { firstQuestion, modalOnScreen } from './modalLayer'

function request(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    id: 'ask_1',
    projectId: 'p1',
    terminalId: 't_7',
    handle: 'priya',
    publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
    since: 1_000,
    at: 1_500,
    expiresAt: 2_000,
    writes: 4,
    bytes: 4,
    preview: 'npm test⏎',
    clipped: false,
    ...overrides
  }
}

describe('which question goes on screen', () => {
  it('puts up the oldest, one at a time', () => {
    const first = request({ id: 'ask_1', since: 100 })
    const second = request({ id: 'ask_2', since: 200 })
    expect(firstQuestion({ p1: { requests: [second, first] } })?.id).toBe('ask_1')
  })

  // Two teammates on two projects is still one question at a time, and still
  // the oldest of them: a queue that restarted per project would put the second
  // person's prompt in front of the first person's.
  it('reads across every project at once', () => {
    const mine = request({ id: 'ask_1', projectId: 'p1', since: 300 })
    const theirs = request({ id: 'ask_2', projectId: 'p2', since: 200 })
    expect(firstQuestion({ p1: { requests: [mine] }, p2: { requests: [theirs] } })?.id).toBe('ask_2')
  })

  it('puts up nothing when nobody is waiting', () => {
    expect(firstQuestion({ p1: { requests: [] } })).toBeNull()
    expect(firstQuestion({})).toBeNull()
  })
})

describe('whether anything is holding the window', () => {
  it('is false with nothing open', () => {
    expect(modalOnScreen({ dialog: null, consent: {} })).toBe(false)
    expect(modalOnScreen({ dialog: null, consent: { p1: { requests: [] } } })).toBe(false)
  })

  it('counts a dialog this window opened', () => {
    expect(modalOnScreen({ dialog: { kind: 'appearance' }, consent: {} })).toBe(true)
  })

  // The half that was missing everywhere. A keystroke question is a modal that
  // nobody in this window opened and that refuses Escape, which makes it the
  // one it is least safe to act underneath.
  it('counts a question a teammate’s machine raised', () => {
    expect(modalOnScreen({ dialog: null, consent: { p1: { requests: [request()] } } })).toBe(true)
  })
})
