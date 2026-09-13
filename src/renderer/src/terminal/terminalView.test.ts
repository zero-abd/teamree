// What a keystroke the runtime refused puts on the screen.
//
// The pane keeps a blinking cursor after the process behind it has gone, so a
// keystroke still looks like it went somewhere. The exit line is above it and
// the header says "exited", but the keystroke itself is answered with nothing,
// and nothing is the one answer this app does not give.

import { describe, expect, it } from 'vitest'
import { refusedWriteNotice } from './TerminalView'

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
