/** @vitest-environment jsdom */

// What `TerminalView` draws when a pane's process ends and starts again, and
// who a keypress in a pane belongs to.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier, type ModifierState } from '../keyboard/platformModifier'
import { TERMINAL_OPTIONS_DEFAULT } from '../state/preferences'
import {
  applyEmulatorOptions,
  clearIntoScrollback,
  copyOnSelect,
  emulatorOptions,
  EXIT_RESET,
  paneKeyIntent
} from './TerminalView'

const APPLE = resolvePlatformModifier('darwin')

describe('an exit, drawn', () => {
  // Claude's trust prompt, as the real binary drew it: inline, cursor parked four rows up.
  const trust = readFileSync(
    path.join(import.meta.dirname, '../../../main/terminals/fixtures/claude-trust.txt'),
    'utf8'
  )

  it('leaves the screen the program left and writes nothing over it', async () => {
    const term = emulator()
    await write(term, trust)
    const before = screen(term)
    await write(term, EXIT_RESET)
    expect(screen(term)).toEqual(before)
    expect(screen(term).join('\n')).not.toMatch(/\[.*exit/)
  })

  it('leaves the alternate screen and every mode the program turned on', async () => {
    const term = emulator()
    await write(term, 'repo % claude\r\n')
    await write(term, `\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[5;20r\x1b[7m${trust}`)
    await write(term, EXIT_RESET)
    expect(term.buffer.active.type).toBe('normal')
    expect(screen(term)[0]).toBe('repo % claude')
    expect(screen(term).join('\n')).not.toContain('Quick safety check')
    expect(term.modes).toMatchObject({
      mouseTrackingMode: 'none',
      bracketedPasteMode: false,
      applicationCursorKeysMode: false
    })
  })

  it('runs again on a clear screen, the old one kept in the scrollback', async () => {
    const term = emulator()
    await write(term, trust)
    await write(term, EXIT_RESET)
    clearIntoScrollback(term, '\r\n\x1b[2m[end of record]\x1b[0m\r\n')
    await write(term, 'fresh run')
    const rows = screen(term)
    expect(rows[0]).toBe('fresh run')
    expect(rows.slice(1).every((row) => row === '')).toBe(true)
    const above = scrollback(term)
    const question = above.findIndex((row) => row.startsWith(' Quick safety check: Is this a project'))
    expect(question).toBeGreaterThanOrEqual(0)
    expect(above.findIndex((row) => row.includes('Enter to confirm'))).toBeGreaterThan(question)
    expect(above.at(-1)).toBe('[end of record]')
    // Only that one clear goes to the scrollback; the program's own keep the terminal's default.
    expect(term.options.scrollOnEraseInDisplay).toBe(false)
  })
})

function emulator(): XTerm {
  return new XTerm({ cols: 100, rows: 30, scrollback: 200, allowProposedApi: true })
}

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function screen(term: XTerm): string[] {
  const buffer = term.buffer.active
  return Array.from(
    { length: term.rows },
    (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
  )
}

function scrollback(term: XTerm): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.baseY }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
}

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
