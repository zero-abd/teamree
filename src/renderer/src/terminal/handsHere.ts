// Whether a person in this window produced these bytes, or the emulator did.
//
// Shared by both panes because both ask it, for reasons that look unrelated and
// are the same question. `WatchedPaneView` asks before sending a byte onto
// somebody else's machine. `TerminalView` asks before telling the runtime that
// this pane was typed into — a fact the next launch reads as "there is a
// conversation here worth resuming".

/**
 * Whether somebody in this window is doing something to this pane right now.
 *
 * THE EMULATOR TALKS BACK, AND NOT ONLY WHEN IT IS TYPED INTO. Terminal output
 * is a stream of instructions, and several of them are questions: a
 * cursor-position report, a device-attributes request, a mode query, ENQ's
 * answerback. An emulator answers them by *sending bytes*, and xterm delivers
 * those answers on the very same `onData` a keystroke arrives on, with nothing
 * to tell the two apart. `scrollbackRecord.ts` already made this argument for a
 * record replayed off disk and said, correctly, that live it is merely a
 * conversation — a program asked its own terminal a question and read the answer
 * on its own stdin.
 *
 * That sentence is true of the bytes and false of anything either pane says
 * about them, which is why both ask this.
 *
 * On a watched pane the program is on somebody else's machine, this emulator is
 * a second one reading the same bytes, and its answer does not go back to the
 * program: it goes to `teamwork.type`, which is a keystroke, with this reader's
 * name on it. So a teammate whose agent prints `ESC[6n` — which full-screen
 * programs do constantly — would have every watcher's window type a cursor
 * report into their pty, land it in their audit log as the watcher's
 * keystrokes, and put "ana is typing" on their pane while ana did nothing at
 * all. Worse where the watcher has no standing permission: the owner's machine
 * holds the bytes and asks them to consent to a keystroke nobody pressed.
 *
 * On a pane of your own the reply reaching the program is exactly right, and
 * what the runtime concludes from it is not. A write is read there as a person
 * typing: it records `typed` and retires the pane's restored badge. An agent
 * asks its terminal what it is within a second of starting, so a pane nobody
 * had touched recorded that somebody had — and a pane brought back to resume a
 * conversation stopped being a restored pane before the refusal it came back
 * for arrived, taking with it the fresh agent that refusal was meant to start.
 * See `TerminalRecord.typed`.
 *
 * So the bytes either view calls a person's are the ones a person made. Every way
 * xterm turns an action into data — a key, an IME composition, a paste, a mouse
 * report — begins as a DOM event inside the terminal's own element, and a
 * capture listener there runs before xterm's own handler does. A reply has no
 * such event behind it, which is exactly the distinction that was missing.
 * The mark lasts one microtask, which is long enough: xterm raises `onData`
 * synchronously inside the handler for the event that caused it, and its replies
 * come out of `write()` in a later task.
 *
 * `mark` is that last sentence's exception, and there is one. A paste read off
 * the system clipboard comes back a turn of the loop later, so the action that
 * asked for it is over by the time there is anything to write — the person is
 * no less real, the DOM event is simply in the past. Whoever resumes that
 * action says so, and the mark covers the write it makes on the spot.
 */
export type HandsHere = { acting: () => boolean; mark: () => void; stop: () => void }

/**
 * The events that count as somebody acting on this pane.
 *
 * Deliberately the broad list rather than just `keydown`: composition is how
 * anything but a Latin keyboard types, `paste` is a menu item as well as a
 * chord, and the mouse is data whenever the far end has asked for mouse
 * reporting. Missing one of these would not be a hole — it would be a pane that
 * quietly stopped accepting a way of typing.
 */
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
