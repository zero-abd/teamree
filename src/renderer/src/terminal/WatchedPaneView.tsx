// A teammate's pane, open for reading and — since milestone D — for typing.
//
// This is deliberately NOT `TerminalView` with a flag. A pane of your own and a
// pane on somebody else's machine are two different objects in the world, and
// the differences are structural rather than cosmetic:
//
// **Typing is a request, not a write.** A keystroke here goes to
// `teamwork.type`, crosses a relay as `terminal.write`, and is judged by the
// owner's machine before it reaches anything. It can be refused — the owner can
// mute this pane, their process can have exited, their link can have gone — and
// every refusal is printed into the pane where the keystroke would have
// appeared. A keystroke that silently went nowhere would leave somebody
// believing they had typed into a shell two thousand miles away, which is its
// own kind of lie and the failure this view exists to make impossible.
//
// **And it is a request a person here has to have made.** An emulator sends
// bytes of its own accord — it answers the questions a program asks it — and on
// a pane of your own that is a conversation with your own shell. On this one it
// would be the far end's output typing into the far end's pty under this
// reader's name. So only what somebody in this window actually did is sent, and
// `handsHere.ts` is the whole of that argument.
//
// **And it is a request somebody has to answer.** Unless the owner has already
// said this teammate may type in this pane, their machine holds the bytes and
// asks them, and nothing runs until they say. From here that looks like an
// answer taking longer than a round trip should, so after a moment the pane
// says exactly that — that nothing has come back and nothing has run — and says
// it again when the wait ends, whichever way it ended. What this side is
// deliberately *not* told is that a prompt went up: whether somebody is at that
// keyboard right now is the owner's business, and a teammate who could tell
// would have learned it by typing.
//
// **The size is the owner's.** `docs/teamwork.md` is explicit: a watcher with a
// smaller window is letterboxed rather than resizing a pty under a program that
// is only being read. So the emulator is built at the owner's columns and rows
// and never refits to *this* window; the whole picture is scaled down to fit
// the viewer, with bars where it does not reach. Scaling is a CSS transform,
// which touches nothing on the far machine. That stays true now that typing
// works: a keystroke is not a resize, and `terminal.resize` is still not a
// method a teammate may call.
//
// It does follow the owner, though, because it has to. A split dragged on their
// machine reflows their pty, and from that byte on their output is addressed to
// a geometry this emulator is not — a full-screen TUI, which is what an agent
// pane is, becomes wrapped nonsense and stays that way for the rest of the
// watch. Nothing on the stream says a resize happened, so the size is read from
// their presence, which carries it for the sidebar already.
//
// **The stream can be honest about its own gaps.** A local pane cannot lose
// output on the way to the screen. This one can — the relay has a budget and a
// chatty agent can beat it — and when that happens the notice is written into
// the pane, in place, where the missing output would have been.
//
// None of that is an argument for it being a different *object* on the screen,
// and for a while it was: a card floating over the window at a fixed size in a
// fixed corner, which could not be moved, resized or closed with the chord that
// closes panes. So it is an ordinary pane now — the same chrome, the same
// focused border, the same close button, the same gutter to drag — and the
// distinction it has to carry is carried in words and in an accent rather than
// by being a different kind of thing. The letterboxing is what makes that safe:
// the slot resizes, the scale follows it, and the owner's pty never hears about
// any of it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { teammatesHeard, type TeammatePresence } from '@shared/entities'
import type { WatchedPaneEvent } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { handsHere, type HandsHere } from './handsHere'
import { readTerminalTheme, TERMINAL_FONT_FAMILY } from './terminalTheme'

/** Written into the pane itself, because that is where the fact belongs. */
const DIM = '\u001b[38;5;244m'
const RESET = '\u001b[0m'
const WARN = '\u001b[38;5;173m'

/**
 * How long one refusal stands for the keystrokes behind it.
 *
 * Somebody typing at a muted pane sends a keystroke per key, and would
 * otherwise be told once per key. Saying it once and holding for a moment keeps
 * the pane readable without ever letting a keystroke vanish in silence: the
 * ones in between met the same refusal, and it is already on the screen.
 */
const REFUSAL_QUIET_MS = 3_000

/**
 * How long a keystroke may go unanswered before this view says so.
 *
 * Typing into somebody else's pane is a round trip, and a round trip that is
 * merely slow is not worth a sentence. What *is* worth one is a keystroke that
 * has stopped being a round trip and started being a question on somebody's
 * screen: the owner's machine holds the bytes and asks them, which takes as
 * long as a person takes.
 *
 * A second, because nothing legitimate takes that long and because the person
 * typing has by then noticed that their letters are not appearing. What is said
 * is deliberately a statement about this side's own knowledge — nothing has come
 * back — rather than a claim about what the owner is doing. This machine is not
 * told that a prompt went up, and it should not be: that a person is sitting at
 * that keyboard right now is the owner's business, not the typist's.
 */
const HELD_NOTICE_MS = 1_000

type WatchedPaneViewProps = {
  projectId: string
  /** The namespaced id `teamwork.presence` hands out, not the owner's own. */
  paneId: string
  /** What to call the pane in the header, as the sidebar already names it. */
  label: string
  handle: string
  /** Whether this is the pane the next keystroke goes to, as any pane is. */
  focused: boolean
  onFocus: () => void
  /** Chords the app owns; they must not be typed onto somebody else's machine. */
  isAppChord: (event: KeyboardEvent) => boolean
  /** The close chord, named on the button, exactly as a local pane names it. */
  closeHint: string
  onClose: () => void
  /** Every chunk that reaches the screen, so a row elsewhere can quote its last line. */
  onOutput?: (data: string) => void
}

type WatchState =
  | { phase: 'opening' }
  | { phase: 'watching'; cols: number; rows: number }
  | { phase: 'ended'; reason: string }

/** The last thing the owner's machine said no to, for the header to repeat. */
type Refusal = { reason: string; at: number }

export function WatchedPaneView({
  projectId,
  paneId,
  label,
  handle,
  focused,
  onFocus,
  isAppChord,
  closeHint,
  onClose,
  onOutput
}: WatchedPaneViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<WatchState>({ phase: 'opening' })
  const [refused, setRefused] = useState<Refusal | null>(null)
  // True while this side has sent keystrokes and heard nothing back about any
  // of them. A fact about this window's own promises, which is the only thing
  // it honestly knows — see `HELD_NOTICE_MS`.
  const [holding, setHolding] = useState(false)
  const outputRef = useRef(onOutput)
  outputRef.current = onOutput
  const chordRef = useRef(isAppChord)
  chordRef.current = isAppChord
  // Read inside the effect that builds the emulator, which can finish after the
  // focus has already moved here: a pane opened by the chord is focused from
  // its first frame, and its emulator does not exist until the watch is
  // answered a tick or two later.
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  // The owner's dimensions, as their last presence reported them. Nothing on
  // the watch stream carries a resize, so this is the only way this side is
  // ever told that their pane is a different shape than it was.
  const presence = useWorkspaceStore((store) => store.teammates[projectId])
  const appearance = useWorkspaceStore((store) => store.appearance)
  const size = useMemo(() => watchedPaneSize(presence, paneId), [presence, paneId])
  const sizeRef = useRef(size)
  sizeRef.current = size
  // The reader's own setting, not the owner's. Their columns and rows are
  // theirs and this view never changes them, but how large those cells are
  // drawn on *this* screen is a question about this screen — and this pane was
  // the one surface that ignored the answer, hard-coding 12 while every local
  // pane followed the setting.
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const fontSizeRef = useRef(fontSize)
  const termRef = useRef<XTerm | null>(null)
  const refitRef = useRef<(() => void) | null>(null)
  const openedAtRef = useRef(0)

  useEffect(() => {
    const host = hostRef.current
    const frame = frameRef.current
    if (!host || !frame) return

    // When this side asked, which is what dates the size the answer comes back
    // with. Presence heard after it is newer news than the answer was.
    const openedAt = Date.now()
    openedAtRef.current = openedAt

    let alive = true
    let term: XTerm | null = null
    let webgl: WebglAddon | null = null
    let subscription: { close: () => void } | null = null
    let observer: ResizeObserver | null = null
    let hands: HandsHere | null = null

    /**
     * Fits the owner's picture into whatever room this window has.
     *
     * Only ever shrinks. A teammate's 80-column pane blown up to fill a wide
     * window would be a different thing from what they are looking at, and the
     * point of this view is that it is the same thing.
     */
    const letterbox = (): void => {
      const element = term?.element
      if (!alive || !element) return
      element.style.transform = 'scale(1)'
      const width = element.offsetWidth
      const height = element.offsetHeight
      if (width === 0 || height === 0) return
      const scale = Math.min(1, frame.clientWidth / width, frame.clientHeight / height)
      element.style.transform = `scale(${scale})`
    }

    /**
     * Everything that reaches the screen, including what arrives before there
     * is a screen.
     *
     * `openStream` registers the listener and replays whatever the runtime sent
     * ahead of its own response inside its own continuation — one tick before
     * the `.then` below builds the emulator. So the opening bytes of a watch
     * can land while `term` is still null, and `term?.write` discards them with
     * nothing said. `TerminalView` holds its snapshot window against the same
     * ordering; this is the same guard for the same reason.
     */
    const held = heldWrites()

    const write = (text: string): void => {
      held.write(text)
      outputRef.current?.(text)
    }

    /**
     * Says no once, in the pane, where the keystroke would have gone.
     *
     * Deduplicated by reason and not by keystroke: a held key against a muted
     * pane is one refusal repeated, and printing it forty times would bury the
     * output the reader is actually here for. A *different* refusal is always
     * printed, and so is the same one again after the pane has been quiet.
     */
    let last: Refusal | null = null
    const refuse = (reason: string): void => {
      if (!alive) return
      const at = Date.now()
      if (last && last.reason === reason && at - last.at < REFUSAL_QUIET_MS) return
      last = { reason, at }
      held.write(`\r\n${WARN}[not typed: ${reason}]${RESET}\r\n`)
      setRefused(last)
    }

    /** Typing is working again, so the header must stop saying it is not. */
    const accepted = (): void => {
      if (!alive || last === null) return
      last = null
      setRefused(null)
    }

    /**
     * Keystrokes this side has sent and has heard nothing back about.
     *
     * Counted rather than assumed: "nothing has been answered" is a fact about
     * this window's own promises, so the sentence it produces is true whether
     * the owner is reading a prompt, the relay is slow, or their machine is
     * busy. Guessing at which of those it is would be this view inventing news
     * about somebody else's desk.
     */
    let waiting = 0
    let saidHeld = false
    let heldTimer: ReturnType<typeof setTimeout> | undefined

    const sent = (): void => {
      waiting += 1
      if (heldTimer !== undefined) return
      heldTimer = setTimeout(() => {
        heldTimer = undefined
        if (!alive || waiting === 0 || saidHeld) return
        saidHeld = true
        setHolding(true)
        held.write(
          `\r\n${DIM}[waiting: nothing you have typed has run — ${handle}’s machine has not answered yet]${RESET}\r\n`
        )
      }, HELD_NOTICE_MS)
    }

    /**
     * One of those keystrokes, answered at last.
     *
     * The line is printed only when the wait was announced, and only when the
     * last of them settles: a burst held together is one wait and one end to
     * it. Said for a keystroke that landed as well as for one that did not,
     * because a pane at a password prompt echoes nothing — without this, being
     * allowed and being ignored would look the same from here.
     */
    const answered = (landed: boolean): void => {
      waiting = Math.max(0, waiting - 1)
      if (waiting > 0) return
      if (heldTimer !== undefined) {
        clearTimeout(heldTimer)
        heldTimer = undefined
      }
      if (!saidHeld) return
      saidHeld = false
      if (alive) setHolding(false)
      if (landed) held.write(`\r\n${DIM}[no longer held: what you typed has run]${RESET}\r\n`)
    }

    /**
     * One keystroke, on its way to somebody else's shell.
     *
     * Not awaited and not queued: the transport writes frames in the order
     * `call` was made and this handler is synchronous, so the order keys were
     * pressed in is the order they arrive in. Awaiting would make a slow link
     * reorder nothing and drop everything a person typed while it thought.
     */
    const send = (data: string): void => {
      sent()
      void runtimeClient.call('teamwork.type', { projectId, paneId, data }).then(
        () => {
          answered(true)
          accepted()
        },
        (error: unknown) => {
          answered(false)
          refuse(error instanceof Error ? error.message : String(error))
        }
      )
    }

    /**
     * The last word, and it stays the last word.
     *
     * A watch can end before it has finished opening — the teammate's machine
     * can stop answering between the runtime accepting the request and the
     * stream being answered — and the `lost` for that arrives while this view
     * is still showing "Opening…". Without this, the continuation below would
     * then overwrite the stated reason with `watching` and leave a window that
     * looks live and will never move again, which is the failure this view
     * exists to make impossible pointed the reassuring way.
     */
    const end = (reason: string): void => {
      if (!alive) return
      setState((current) => (current.phase === 'ended' ? current : { phase: 'ended', reason }))
    }

    /** Said once: a peer that is sending nonsense tends to keep sending it. */
    let saidUnreadable = false

    const onEvent = (incoming: WatchedPaneEvent): void => {
      if (!alive) return
      // Typed as an event, but nothing between their machine and here has ever
      // looked at it: `paneWatch` re-emits a peer's stream frames as it finds
      // them, where presence on the same link is parsed before it is believed.
      const event = readWatchedPaneEvent(incoming)
      if (event === null) {
        // In the pane, because a frame quietly dropped is output the reader is
        // never told they did not get.
        if (saidUnreadable) return
        saidUnreadable = true
        held.write(`\r\n${DIM}[their machine sent something this pane cannot read]${RESET}\r\n`)
        return
      }
      if (event.type === 'data') {
        write(event.data)
        return
      }
      if (event.type === 'exit') {
        held.write(`\r\n${DIM}[their process exited with code ${event.exitCode}]${RESET}\r\n`)
        return
      }
      if (event.type === 'elided') {
        // In the stream, at the point of the hole. A viewer that quietly
        // skipped the bytes would be showing a transcript that never happened.
        held.write(`\r\n${DIM}[${event.bytes} bytes skipped: this pane is outrunning the relay]${RESET}\r\n`)
        return
      }
      if (event.type === 'lost') {
        // Whatever ended it — their machine, their pane, or the relay — the
        // reader is told in the pane and on the header, because a viewer that
        // simply stopped updating reads as a teammate who went quiet.
        held.write(`\r\n${DIM}[stopped watching: ${event.reason}]${RESET}\r\n`)
        end(event.reason)
      }
    }

    void runtimeClient
      .watchPane(projectId, paneId, onEvent)
      .then((opened) => {
        if (!alive) {
          opened.subscription.close()
          return
        }
        subscription = opened.subscription

        // The answer carries a read of the owner's pty taken when this was
        // asked for. Presence heard since then is a later read of the same
        // thing, and only a later one is allowed to move the picture.
        const showing = resizeWatchedPane(sizeRef.current, openedAt, opened) ?? {
          cols: opened.cols,
          rows: opened.rows
        }

        term = new XTerm({
          allowProposedApi: true,
          convertEol: false,
          // The cursor is the owner's and is drawn by their pty in the bytes
          // they send. A second one blinking here would be this window's guess
          // at where the far end's is, which is a thing it cannot know.
          cursorBlink: false,
          cursorInactiveStyle: 'none',
          fontFamily: TERMINAL_FONT_FAMILY,
          // From the ref and not the value, for the reason `TerminalView` takes
          // it from a ref: this effect is keyed on the pane, and reading the
          // size out of the closure would make the emulator — with its
          // scrollback and its subscription to somebody else's machine — a
          // thing that had to be torn down and rebuilt to change a number.
          fontSize: fontSizeRef.current,
          lineHeight: 1.25,
          scrollback: 5000,
          theme: readTerminalTheme(document.documentElement),
          // The owner's, and never this window's. It moves when theirs does.
          cols: showing.cols,
          rows: showing.rows
        })
        term.open(host)
        // The app's chords reach the window handler rather than the far end. A
        // pane on somebody else's machine is the last place a stray Cmd-W
        // should land, and this is the same refusal a local pane makes.
        //
        // And it stays that refusal and nothing more. A local pane arbitrates
        // the clipboard chords here (`paneKeyHandler`) and makes the URLs in
        // its scrollback clickable; neither is carried over, because both
        // assume the output is yours. The interrupt half of the copy chord
        // would be a keystroke on somebody else's machine, raised by a chord
        // they cannot see being pressed, and a clickable link would be an
        // address a stream from another machine chose. `docs/renderer-boundary.md`
        // is where that is written down.
        term.attachCustomKeyEventHandler((event) => !chordRef.current(event))
        // Only bytes a person in this window produced. An emulator answers
        // questions of its own accord, and on a pane that is somebody else's
        // the answer would be typed onto their machine under this reader's
        // name; `handsHere` is the whole argument.
        hands = handsHere(term.element)
        term.onData((data) => {
          if (hands?.acting() === true) send(data)
        })
        if (focusedRef.current) term.focus()
        termRef.current = term
        refitRef.current = letterbox

        try {
          webgl = new WebglAddon()
          webgl.onContextLoss(() => {
            webgl?.dispose()
            webgl = null
          })
          term.loadAddon(webgl)
        } catch {
          webgl?.dispose()
          webgl = null
        }

        if (term.element) term.element.style.transformOrigin = 'top left'
        observer = new ResizeObserver(letterbox)
        observer.observe(frame)
        letterbox()
        held.attach((text) => term?.write(text))
        setState((current) =>
          current.phase === 'ended' ? current : { phase: 'watching', cols: showing.cols, rows: showing.rows }
        )
      })
      .catch((error: unknown) => {
        end(error instanceof Error ? error.message : String(error))
      })

    return () => {
      alive = false
      if (heldTimer !== undefined) clearTimeout(heldTimer)
      termRef.current = null
      refitRef.current = null
      observer?.disconnect()
      hands?.stop()
      // The bytes stop here. Closing the subscription is what tells the owner's
      // runtime to stop streaming, which is the whole of "bytes flow on demand".
      subscription?.close()
      webgl?.dispose()
      term?.dispose()
    }
  }, [handle, paneId, projectId])

  /**
   * Follows the owner's pane when it changes shape.
   *
   * Keyed on the size and not on the stream, because the stream has no event
   * for a resize and `terminal.resize` is not a method a teammate may call —
   * the owner's numbers reach this side only as presence. Rebuilding the whole
   * view instead would throw away the scrollback of a watch that is still
   * running, over a change the reader did not make and did not ask for.
   */
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resizeWatchedPane(size, openedAtRef.current, { cols: term.cols, rows: term.rows })
    if (next === null) return
    term.resize(next.cols, next.rows)
    refitRef.current?.()
    setState((current) => (current.phase === 'watching' ? { phase: 'watching', ...next } : current))
  }, [size])

  /**
   * Follows the reader's text size, without telling the owner anything.
   *
   * Larger cells make a larger picture of the same grid, so the letterboxing
   * does the rest: the scale changes and their pty never hears about it. This
   * is the one kind of resize that is safe here — `term.resize` would change
   * *their* geometry, and is what this view exists not to do.
   *
   * The first run is a no-op by construction: the emulator was built at this
   * size a moment ago, and xterm ignores a write of the value it already holds.
   */
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (term === null || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    refitRef.current?.()
  }, [fontSize])

  /**
   * Repaints the emulator when the palette moves under it.
   *
   * The same three lines `TerminalView` has, for the same reason and with the
   * same argument behind them: xterm cannot read CSS, so it is handed literals
   * once when it is built, and without this a pane keeps the colours it opened
   * in forever. That was invisible while the palette could not change; it
   * became a window where choosing a theme repainted the chrome, the rail and
   * every pane of your own, and left a teammate's pane in the old one.
   *
   * It is worse here than on a local pane, too. Closing and reopening is how
   * somebody would otherwise bring a pane over, and for this pane that means
   * dropping a subscription and paying the relay for it again.
   *
   * Read back off the document rather than derived from the appearance here, so
   * that one derivation stands behind both the chrome and the panes — and it
   * runs after `App` has written it because that write is a *layout* effect.
   * Being above this one in the tree is not what puts it first; React flushes
   * passive effects child-first, so a plain `useEffect` there would land after
   * this one and this pane would repaint itself in the theme before last.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = readTerminalTheme(document.documentElement)
  }, [appearance])

  /**
   * Keeps the keyboard where the window says the focus is.
   *
   * The same two lines `TerminalView` has, and deliberately so: a pane that
   * wore the focused border while its emulator did not have the keyboard would
   * be telling somebody their keystrokes were going to a machine they were not
   * going to.
   */
  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused, paneId])

  // One sentence, used twice: on the bar, and as the bar's title for the slot
  // that is too narrow to show all of it. It carries the whole of what typing
  // here means, consent included — leaving out "once they allow it" would
  // promise something this pane no longer does.
  const promise = `what you type runs on ${handle}’s machine, as ${handle}, once they allow it, with your name on it`

  return (
    /* A pane, with the chrome every other pane has. What keeps it unmistakable
       is on the bar rather than in its shape: whose machine it is, what typing
       here does, and an accent border that is nobody's local pane. */
    <section
      className={`pane pane--watched${focused ? ' pane--focused' : ''}`}
      aria-label={`${handle}’s pane ${label}, which you can type into`}
      onFocus={onFocus}
      onMouseDown={onFocus}
    >
      {/* The same bar a local pane has, carrying the things only this pane has
          to say. The whole sentence is on the bar's own title as well, because
          a narrow slot ellipsises it and the fact must survive the narrowing. */}
      <header className="pane__bar pane__bar--watched" title={promise}>
        <span className="watch__owner">{handle}</span>
        <span className="pane__title">{label}</span>
        {/* Said in words, on the pane, at all times, and said about the person
            reading it rather than about the feature. The design's argument for
            why any of this is survivable is that nothing is ambiguous — and
            that includes being unambiguous with the person doing the typing
            about the fact that their name is on it. */}
        <span
          className={`watch__typing${refused ? ' watch__typing--refused' : ''}${holding ? ' watch__typing--held' : ''}`}
        >
          {refused
            ? refused.reason
            : holding
              ? `waiting for ${handle}’s machine — nothing you have typed has run`
              : promise}
        </span>
        {state.phase === 'watching' ? (
          <span className="pane__meta" title="their pane’s size, which a reader never changes">
            {`${state.cols}×${state.rows}`}
          </span>
        ) : null}
        {/* The close button every pane has, in the place every pane has it.
            Closing is stopping the watch — there is nothing else to stop — so
            it says so, and it names the same chord a local pane's does. */}
        <button
          type="button"
          className="pane__close"
          title={`Stop watching ${handle}’s ${label} · ${closeHint}`}
          aria-label={`Stop watching ${handle}’s pane ${label}`}
          onClick={onClose}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>

      <div className="watch__frame" ref={frameRef}>
        <div className="watch__surface" ref={hostRef} />
        {state.phase === 'opening' ? <p className="watch__note">Opening {handle}’s pane…</p> : null}
        {state.phase === 'ended' ? <p className="watch__note watch__note--ended">{state.reason}</p> : null}
      </div>
    </section>
  )
}

/** The owner's dimensions for one pane, and when this machine last heard them. */
export type WatchedPaneSize = { cols: number; rows: number; heardAt: number }

/**
 * What a teammate's last presence says one of their panes measures.
 *
 * Null when they send none: a peer that has not been rebuilt carries no
 * dimensions at all, and a watcher that filled in a guess would draw a frame
 * the output does not fit.
 */
export function watchedPaneSize(presence: TeammatePresence | undefined, paneId: string): WatchedPaneSize | null {
  // A project teamwork has not read yet is the same answer as a teammate who
  // has sent no dimensions: nothing is known about this pane's shape, and the
  // frame stays where it is rather than moving to a guess.
  for (const worktree of teammatesHeard(presence)?.worktrees ?? []) {
    for (const pane of worktree.panes) {
      if (pane.id !== paneId) continue
      if (pane.cols === undefined || pane.rows === undefined) return null
      return { cols: pane.cols, rows: pane.rows, heardAt: worktree.heardAt }
    }
  }
  return null
}

/**
 * The size to move a watched pane to, or null to leave it where it is.
 *
 * Presence is periodic and the stream's answer is not, so the two can disagree
 * about a pane that has just been resized. `openedAt` breaks the tie by age:
 * the answer is a read of the owner's pty taken when the watch was asked for,
 * and presence heard before that is the same fact read earlier rather than news
 * of a resize — adopting it would walk a freshly opened pane backwards.
 */
export function resizeWatchedPane(
  size: WatchedPaneSize | null,
  openedAt: number,
  showing: { cols: number; rows: number }
): { cols: number; rows: number } | null {
  if (size === null || size.heardAt <= openedAt) return null
  if (size.cols === showing.cols && size.rows === showing.rows) return null
  return { cols: size.cols, rows: size.rows }
}

/**
 * One frame off a teammate's link, or nothing.
 *
 * `paneWatch` re-emits a peer's stream events into this channel exactly as they
 * arrive, where presence on the same link is parsed before it is believed. So
 * this is the first place the shape is checked, and until the main side checks
 * it too it is the only one: `term.write(42)` is one broken — or one hostile —
 * teammate away. Rebuilt from the fields that were checked, so nothing else the
 * payload was carrying rides in behind them.
 */
export function readWatchedPaneEvent(value: unknown): WatchedPaneEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, data, exitCode, title, at, bytes, reason } = value as Record<string, unknown>
  switch (type) {
    case 'data':
      return typeof data === 'string' ? { type: 'data', data } : null
    case 'exit':
      return Number.isInteger(exitCode) ? { type: 'exit', exitCode: exitCode as number } : null
    case 'title':
      return typeof title === 'string' ? { type: 'title', title } : null
    case 'bell':
      return Number.isFinite(at) ? { type: 'bell', at: at as number } : null
    case 'elided':
      return Number.isInteger(bytes) ? { type: 'elided', bytes: bytes as number } : null
    case 'lost':
      return typeof reason === 'string' ? { type: 'lost', reason } : null
    default:
      return null
  }
}

/**
 * Writes held until there is something to write them to.
 *
 * The emulator is built one continuation after the one that registers the
 * stream and replays its buffered arrivals, so the first bytes of a watch can
 * reach this view before there is a terminal at all. They are kept rather than
 * dropped, in order, and go out the moment there is one.
 */
export function heldWrites(): { write: (text: string) => void; attach: (to: (text: string) => void) => void } {
  let out: ((text: string) => void) | null = null
  const held: string[] = []
  return {
    write: (text) => {
      if (out === null) held.push(text)
      else out(text)
    },
    attach: (to) => {
      out = to
      for (const text of held.splice(0)) to(text)
    }
  }
}
