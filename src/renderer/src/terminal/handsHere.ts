// Whether a person in this window produced these bytes, or the emulator did. xterm sends replies to
// terminal queries (`ESC[6n`, DA, ENQ) on the same `onData` as keystrokes; on a watched pane they
// would be typed into a teammate's pty as ours, and on our own they would mark the pane `typed`
// and retire its restored badge (see `TerminalRecord.typed`).

/**
 * A capture listener marks real input for one microtask (xterm raises `onData` synchronously inside the
 * event; replies come later from `write()`). `mark` covers a clipboard paste resolved a turn later.
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
  let acting = false
  const mark = (): void => {
    acting = true
    queueMicrotask(() => {
      acting = false
    })
  }
  for (const type of HANDS_EVENTS) element?.addEventListener(type, mark, true)
  return {
    acting: () => acting,
    mark,
    stop: () => {
      for (const type of HANDS_EVENTS) element?.removeEventListener(type, mark, true)
    }
  }
}
