/** @vitest-environment jsdom */

// The real emulator, answering questions nobody asked it.
//
// `WatchedPaneView.test.tsx` replaces xterm with a recorder, which is right for
// everything it asserts — but it means the fact this file is about would be
// invisible there: that xterm sends bytes on its own, that it sends them on the
// same `onData` a keystroke arrives on, and that the only thing separating the
// two is whether a person did something. That is a property of the emulator
// rather than of this project, so a recorder cannot state it and a change in a
// dependency could take it away without a single test going red.
//
// So this one drives the real thing. No canvas, no layout and no renderer — the
// parser and the input handler are all that is needed, and jsdom has enough DOM
// for both.

import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { handsHere } from './WatchedPaneView'

const ESC = ''
/** The 8-bit form of CSI. The same sequences, one byte instead of two. */
const CSI = ''

/** A terminal on a page, with what it says and who made it say it. */
function emulator(): {
  term: XTerm
  element: HTMLElement
  sent: string[]
  unprompted: string[]
  write: (data: string) => Promise<void>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 })
  term.open(host)
  const element = term.element as HTMLElement

  const hands = handsHere(element)
  const sent: string[] = []
  const unprompted: string[] = []
  term.onData((data) => {
    if (hands.acting()) sent.push(data)
    else unprompted.push(data)
  })

  return {
    term,
    element,
    sent,
    unprompted,
    // Resolved a task later than the parser finishes, because the replies are
    // raised from inside the write and the assertion is about what came out.
    write: (data) =>
      new Promise<void>((resolve) => {
        term.write(data, () => setTimeout(resolve, 0))
      })
  }
}

describe('what a stream can make an emulator say', () => {
  // Every one of these is ordinary output. A full-screen program asks its
  // terminal where the cursor is and what it can do, constantly — which is why
  // this is not an exotic payload but the normal behaviour of an agent pane.
  it.each([
    ['a cursor-position report', `${ESC}[6n`],
    ['a device-attributes request', `${ESC}[c`],
    ['a secondary device-attributes request', `${ESC}[>c`],
    ['a status report', `${ESC}[5n`],
    ['a mode query', `${ESC}[?1049$p`],
    ['a request for the current attributes', `${ESC}P$qm${ESC}\\`],
    ['the same thing in 8-bit form, which no seven-bit filter would catch', `${CSI}6n`]
  ])('%s comes back as bytes the emulator sends', async (_name, payload) => {
    const { write, unprompted, sent } = emulator()
    await write(payload)
    expect(unprompted.join('')).not.toBe('')
    // And it arrived on the same event a keystroke does, which is the whole
    // difficulty: nothing about the bytes says where they came from.
    expect(sent).toEqual([])
  })

  // Two things xterm does not do, checked because a note saying "xterm has no
  // OSC 52" is worth exactly as much as the version it was written against.
  it('does not write the clipboard, and does not rename the window', async () => {
    const { write, unprompted, sent } = emulator()
    const before = document.title
    await write(`${ESC}]52;c;aGVsbG8=${ESC}\\${ESC}]0;renamed${ESC}\\`)
    expect(unprompted).toEqual([])
    expect(sent).toEqual([])
    expect(document.title).toBe(before)
  })
})

describe('telling a person from a stream', () => {
  it('sends what somebody typed', async () => {
    const { element, sent, unprompted } = emulator()
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual(['a'])
    expect(unprompted).toEqual([])
  })

  // The mark is on the action rather than on the bytes, so the same string is
  // sent or not sent depending only on whether somebody produced it. This is
  // the pair to the reply cases above: identical data, opposite answer.
  it('sends a cursor report a person typed, and not one the stream provoked', async () => {
    const { element, term, sent, unprompted, write } = emulator()
    await write(`${ESC}[6n`)
    expect(unprompted).toEqual([`${ESC}[1;1R`])
    expect(sent).toEqual([])

    // The same bytes, this time because somebody pasted them.
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => `${ESC}[1;1R` } })
    element.querySelector('textarea')?.dispatchEvent(paste)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([`${ESC}[1;1R`])
    term.dispose()
  })

  // The listeners come off with the pane. A gate left attached to a disposed
  // emulator's element would be a leak rather than a hole, but it would also
  // mean the pane that replaced it was being judged by the wrong one.
  it('stops watching when the pane goes', async () => {
    const { element } = emulator()
    const hands = handsHere(element)
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(hands.acting()).toBe(true)
    await Promise.resolve()
    expect(hands.acting()).toBe(false)

    hands.stop()
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(hands.acting()).toBe(false)
  })
})
