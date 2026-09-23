/** @vitest-environment jsdom */

// The one chord that means two things, against the real emulator.
//
// A pane's ⌘C is a copy when something is selected and an interrupt when
// nothing is, and everything that makes that hard to get right is in the wiring
// rather than in the rule: whether the bytes reach the pty, whether the
// emulator also gets the press, whether a paste arrives with the brackets the
// program asked for. So this drives a real `XTerm` with the real handler and
// watches both ends — what the clipboard was given, and what came out on
// `onData`, which is the wire to the pty.
//
// `terminalView.test.ts` states the rule on its own, over data. This states
// what happens.

import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { paneKeyHandler } from './TerminalView'

const APPLE = resolvePlatformModifier('darwin')

/** A pane, with the two ends of it in view. */
function pane(options: { clipboard?: string; isAppChord?: (event: KeyboardEvent) => boolean } = {}): {
  term: XTerm
  /** Everything the emulator sent towards the pty. */
  sent: string[]
  /** Everything handed to the system clipboard. */
  copied: string[]
  press: (key: string, modifiers?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => void
  write: (data: string) => Promise<void>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 })
  term.open(host)

  const sent: string[] = []
  const copied: string[] = []
  term.onData((data) => sent.push(data))

  const handler = paneKeyHandler({
    isAppChord: options.isAppChord ?? (() => false),
    term,
    modifier: APPLE,
    send: (data) => sent.push(data),
    clipboard: {
      copy: (text) => copied.push(text),
      read: () => Promise.resolve(options.clipboard ?? '')
    }
  })
  term.attachCustomKeyEventHandler(handler)

  return {
    term,
    sent,
    copied,
    // Dispatched at the emulator rather than handed to the handler, because
    // "and the emulator did not also get it" has to be a fact about the
    // emulator. xterm calls the handler itself and stops where it says stop.
    press: (key, modifiers = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
      // xterm reads the legacy `keyCode` and nothing else when it works out
      // what a control chord means, and `KeyboardEvent` will not take one from
      // its initialiser. Without this the emulator's own Ctrl+C is a keypress
      // it cannot name, which would make the last test below pass for the
      // wrong reason.
      Object.defineProperty(event, 'keyCode', { value: key.toUpperCase().charCodeAt(0) })
      term.textarea?.dispatchEvent(event)
    },
    write: (data) =>
      new Promise<void>((resolve) => {
        term.write(data, () => setTimeout(resolve, 0))
      })
  }
}

describe('the chord that is two commands', () => {
  it('copies the selection, and sends nothing to the pty', async () => {
    const { term, press, sent, copied, write } = pane()
    await write('https://example.com/x')
    term.selectAll()
    expect(term.hasSelection()).toBe(true)

    press('c', { metaKey: true })

    expect(copied).toHaveLength(1)
    expect(copied[0]).toBe(term.getSelection())
    expect(copied[0]).toContain('https://example.com/x')
    // The half that costs work when it is wrong: an agent that was running is
    // still running.
    expect(sent).toEqual([])
  })

  it('sends the interrupt when nothing is selected, and copies nothing', async () => {
    const { press, sent, copied, write } = pane()
    await write('running…')

    press('c', { metaKey: true })

    expect(sent).toEqual(['\u0003'])
    expect(copied).toEqual([])
  })

  it('pastes through the emulator, with the brackets the program asked for', async () => {
    const { press, sent, write } = pane({ clipboard: 'npm test' })
    // Bracketed paste mode, which is what a shell turns on so that it can tell
    // typed text from pasted text.
    await write('\u001b[?2004h')

    press('v', { metaKey: true })
    await Promise.resolve()

    expect(sent).toEqual(['\u001b[200~npm test\u001b[201~'])
  })

  it('pastes plainly when the program did not ask for the brackets', async () => {
    const { press, sent } = pane({ clipboard: 'npm test' })

    press('v', { metaKey: true })
    await Promise.resolve()

    expect(sent).toEqual(['npm test'])
  })

  // The order the three layers are in. An app chord is answered by the window,
  // and must not be read as a clipboard chord on the way past.
  it('lets the app have its own chords first', async () => {
    const { term, press, sent, copied, write } = pane({ isAppChord: (event) => event.key === 'c' })
    await write('selected')
    term.selectAll()

    press('c', { metaKey: true })

    expect(copied).toEqual([])
    expect(sent).toEqual([])
  })

  // Everything that is not the pair belongs to the program, including the
  // control key the interrupt is really spelled with.
  it('leaves every other key to the emulator', async () => {
    const { press, sent, copied } = pane()

    // The control key is how an interrupt is really spelled, and it reaches the
    // program untouched: the emulator answers it, not this handler.
    press('c', { ctrlKey: true })
    press('c', { metaKey: true, shiftKey: true })

    expect(sent).toEqual(['\u0003'])
    expect(copied).toEqual([])
  })
})
