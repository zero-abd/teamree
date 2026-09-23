/** @vitest-environment jsdom */

// The two rules `TerminalView` states as functions: what a keystroke the
// runtime refused puts on the screen, and who a keypress in a pane belongs to.
//
// The pane keeps a blinking cursor after the process behind it has gone, so a
// keystroke still looks like it went somewhere. The exit line is above it and
// the header says "exited", but the keystroke itself is answered with nothing,
// and nothing is the one answer this app does not give.

import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier, type ModifierState } from '../keyboard/platformModifier'
import { TERMINAL_OPTIONS_DEFAULT } from '../state/preferences'
import { applyEmulatorOptions, copyOnSelect, emulatorOptions, paneKeyIntent, refusedWriteNotice } from './TerminalView'

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

function openTerm(options: ConstructorParameters<typeof XTerm>[0] = {}): {
  term: XTerm
  write: (data: string) => Promise<void>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 40, rows: 5, ...options })
  term.open(host)
  return { term, write: (data) => new Promise((resolve) => term.write(data, resolve)) }
}

describe('the emulator options a pane is built with', () => {
  it('are the preferences, in the names xterm reads', () => {
    expect(
      emulatorOptions({
        fontFamily: 'Iosevka',
        cursorStyle: 'block',
        cursorBlink: false,
        optionIsMeta: true,
        copyOnSelect: true,
        scrollback: 20_000
      })
    ).toEqual({
      fontFamily: 'Iosevka',
      cursorStyle: 'block',
      cursorBlink: false,
      macOptionIsMeta: true,
      scrollback: 20_000
    })
  })
})

describe('changing a running pane', () => {
  it('takes every option without rebuilding it, and keeps what has scrolled by', async () => {
    const { term, write } = openTerm(emulatorOptions(TERMINAL_OPTIONS_DEFAULT))
    await write(Array.from({ length: 50 }, (_, line) => `line ${line}`).join('\r\n'))
    const lines = term.buffer.active.length
    expect(lines).toBeGreaterThan(term.rows)

    const refit = applyEmulatorOptions(term, {
      fontFamily: 'Menlo',
      cursorStyle: 'underline',
      cursorBlink: false,
      optionIsMeta: true,
      copyOnSelect: true,
      scrollback: 20_000
    })

    expect(term.options).toMatchObject({
      fontFamily: 'Menlo',
      cursorStyle: 'underline',
      cursorBlink: false,
      macOptionIsMeta: true,
      scrollback: 20_000
    })
    expect(term.buffer.active.length).toBe(lines)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('line 0')
    // A new face changes the cell, so the pty needs a new size.
    expect(refit).toBe(true)
  })

  it('asks for no refit when the font did not move', () => {
    const { term } = openTerm(emulatorOptions(TERMINAL_OPTIONS_DEFAULT))
    expect(applyEmulatorOptions(term, { ...TERMINAL_OPTIONS_DEFAULT, cursorStyle: 'block' })).toBe(false)
  })
})

describe('copy on select', () => {
  it('copies a selection while on, and nothing while off', async () => {
    const { term, write } = openTerm()
    await write('npm test')
    const copied: string[] = []
    let enabled = false
    copyOnSelect(
      term,
      () => enabled,
      (text) => copied.push(text)
    )

    term.selectAll()
    expect(copied).toEqual([])

    term.clearSelection()
    enabled = true
    term.selectAll()
    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain('npm test')
  })

  // Clearing a selection is a selection change too, and must not empty the clipboard.
  it('leaves the clipboard alone when the selection goes away', async () => {
    const { term, write } = openTerm()
    await write('npm test')
    const copied: string[] = []
    copyOnSelect(
      term,
      () => true,
      (text) => copied.push(text)
    )
    term.selectAll()
    term.clearSelection()
    expect(copied).toHaveLength(1)
  })
})
