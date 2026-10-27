// Whether a person in this window produced these bytes, or the emulator did. xterm sends replies to
// terminal queries (`ESC[6n`, DA, ENQ) on the same `onData` as keystrokes; on a watched pane they
// would be typed into a teammate's pty as ours, and on our own they would mark the pane `typed`
// and retire its restored badge (see `TerminalRecord.typed`).

/**
 * A person's event counts until its dispatch ends, which covers the `onData` xterm raises inside it; a microtask
 * would not, as a browser runs them between listeners. `mark` vouches for a menu paste for one microtask.
 */
export type HandsHere = { acting: () => boolean; mark: () => void; stop: () => void }

/** Everything that is somebody acting: IME composition, menu paste and mouse reporting are typing too. */
const HANDS_EVENTS = [
  'keydown',
  'keypress',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'mousedown',
  'mouseup',
  'mousemove',
  'wheel'
] as const

export function handsHere(element: HTMLElement | undefined): HandsHere {
  let event: Event | undefined
  let vouched = false
  const seen = (next: Event): void => {
    event = next
  }
  const mark = (): void => {
    vouched = true
    queueMicrotask(() => {
      vouched = false
    })
  }
  for (const type of HANDS_EVENTS) element?.addEventListener(type, seen, true)
  return {
    acting: () => vouched || (event !== undefined && event.eventPhase !== Event.NONE),
    mark,
    stop: () => {
      for (const type of HANDS_EVENTS) element?.removeEventListener(type, seen, true)
    }
  }
}
