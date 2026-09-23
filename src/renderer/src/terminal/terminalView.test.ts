// The two rules `TerminalView` states as functions: what a keystroke the
// runtime refused puts on the screen, and who a keypress in a pane belongs to.
//
// The pane keeps a blinking cursor after the process behind it has gone, so a
// keystroke still looks like it went somewhere. The exit line is above it and
// the header says "exited", but the keystroke itself is answered with nothing,
// and nothing is the one answer this app does not give.

import { describe, expect, it } from 'vitest'
import { resolvePlatformModifier, type ModifierState } from '../keyboard/platformModifier'
import { paneKeyIntent, refusedWriteNotice } from './TerminalView'

const APPLE = resolvePlatformModifier('darwin')

const refusal = (code: string, message: string): Error => Object.assign(new Error(message), { code })

describe('refusedWriteNotice', () => {
  // `conflict` is what the runtime answers for a terminal that has exited, and
  // the notice matches the register of the exit line already in the buffer.
  it('says in the pane that there is nothing left to type into', () => {
    expect(refusedWriteNotice(refusal('conflict', 'terminal t1 has exited'))).toBe(
      '\r\n\u001b[38;5;244m[this pane has exited]\u001b[0m\r\n'
    )
  })

  // Branching on the code and never on the message: the sentence the runtime
  // writes is free to change, and a refusal matched by its wording would go
  // quiet the day it did.
  it('does not read the reason out of the message', () => {
    expect(refusedWriteNotice(refusal('internal', 'terminal t1 has exited'))).toBeNull()
  })

  it('has nothing to say about a failure that is not the pane being gone', () => {
    expect(refusedWriteNotice(refusal('not_found', 'no terminal t1'))).toBeNull()
    expect(refusedWriteNotice(new Error('the runtime is not answering'))).toBeNull()
    expect(refusedWriteNotice(undefined)).toBeNull()
  })
})

// The rule on its own, over data. `paneKeys.test.ts` drives the real emulator
// through the handler this feeds; what is worth stating here is the one thing
// that test cannot show, which is what the rule does on a machine that is not
// this one.
describe('paneKeyIntent', () => {
  const press = (key: string, modifiers: Partial<ModifierState> = {}): ModifierState & { key: string } => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers
  })

  it('reads the same chord as a copy or as an interrupt, by what is selected', () => {
    expect(paneKeyIntent(press('c', { metaKey: true }), APPLE, true)).toBe('copy')
    expect(paneKeyIntent(press('c', { metaKey: true }), APPLE, false)).toBe('interrupt')
  })

  it('reads the paste chord the same either way', () => {
    expect(paneKeyIntent(press('v', { metaKey: true }), APPLE, true)).toBe('paste')
    expect(paneKeyIntent(press('v', { metaKey: true }), APPLE, false)).toBe('paste')
  })

  // A shifted or alted variant is somebody reaching for something else, and a
  // pane is full of programs that bind those.
  it('claims the bare chord and no relative of it', () => {
    expect(paneKeyIntent(press('c', { metaKey: true, shiftKey: true }), APPLE, true)).toBe('emulator')
    expect(paneKeyIntent(press('v', { metaKey: true, altKey: true }), APPLE, true)).toBe('emulator')
    expect(paneKeyIntent(press('x', { metaKey: true }), APPLE, true)).toBe('emulator')
    expect(paneKeyIntent(press('c'), APPLE, true)).toBe('emulator')
  })

  // The one that matters away from a Mac. Everywhere else the app modifier
  // *is* the control key, Ctrl+C is the interrupt itself, and turning it into a
  // copy because an old selection happened to be lying around would take the
  // one keystroke a terminal must never lose.
  it('leaves the control key alone where the control key is the app modifier', () => {
    const pc = resolvePlatformModifier('linux')
    expect(paneKeyIntent(press('c', { ctrlKey: true }), pc, true)).toBe('emulator')
    expect(paneKeyIntent(press('c', { ctrlKey: true }), pc, false)).toBe('emulator')
    expect(paneKeyIntent(press('v', { ctrlKey: true }), pc, false)).toBe('emulator')
  })
})
