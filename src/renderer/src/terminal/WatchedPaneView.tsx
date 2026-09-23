// A teammate's pane, readable and typeable. Not `TerminalView` with a flag: typing
// is a request the owner's machine may refuse or hold, only a person's own keystrokes
// are sent (`handsHere.ts`), and the size is the owner's — letterboxed, never resized.

import { useEffect, useMemo, useRef, useState } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { teammatesHeard, type TeammatePresence } from '@shared/entities'
import type { WatchedPaneEvent } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { handsHere, type HandsHere } from './handsHere'
import { readTerminalTheme } from './terminalTheme'

/** Written into the pane itself, because that is where the fact belongs. */
const DIM = '\u001b[38;5;244m'
const RESET = '\u001b[0m'
const WARN = '\u001b[38;5;173m'

/** How long one refusal stands for the keystrokes behind it, so a held key is told once. */
const REFUSAL_QUIET_MS = 3_000

/**
 * How long a keystroke may go unanswered before this view says so. A second: no
 * legitimate round trip takes that long. Said as "nothing has come back", never
 * as "a prompt went up" — whether the owner is at their keyboard is their business.
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
  onClose,
  onOutput
}: WatchedPaneViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<WatchState>({ phase: 'opening' })
  const [refused, setRefused] = useState<Refusal | null>(null)
  // True while keystrokes sent from here are unanswered — see `HELD_NOTICE_MS`.
  const [holding, setHolding] = useState(false)
  const outputRef = useRef(onOutput)
  outputRef.current = onOutput
  const chordRef = useRef(isAppChord)
  chordRef.current = isAppChord
  // Read inside the effect that builds the emulator, which can finish after focus
  // has already moved here: a pane opened by the chord is focused from its first frame.
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  // The owner's dimensions come from presence: nothing on the watch stream carries a resize.
  const presence = useWorkspaceStore((store) => store.teammates[projectId])
  const appearance = useWorkspaceStore((store) => store.appearance)
  const size = useMemo(() => watchedPaneSize(presence, paneId), [presence, paneId])
  const sizeRef = useRef(size)
  sizeRef.current = size
  // The reader's own setting: cell size on *this* screen, not the owner's columns and rows.
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const fontSizeRef = useRef(fontSize)
  const fontFamily = useWorkspaceStore((state) => state.terminalOptions.fontFamily)
  const fontFamilyRef = useRef(fontFamily)
  const termRef = useRef<XTerm | null>(null)
  const refitRef = useRef<(() => void) | null>(null)
  const openedAtRef = useRef(0)

  useEffect(() => {
    const host = hostRef.current
    const frame = frameRef.current
    if (!host || !frame) return

    // Dates the size the answer comes back with; presence heard after it is newer news.
    const openedAt = Date.now()
    openedAtRef.current = openedAt

    let alive = true
    let term: XTerm | null = null
    let webgl: WebglAddon | null = null
    let subscription: { close: () => void } | null = null
    let observer: ResizeObserver | null = null
    let hands: HandsHere | null = null

    /** Fits the owner's picture into this window. Only ever shrinks: blown up it would be a different thing. */
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

    // `openStream` replays buffered arrivals one tick before the `.then` below builds
    // the emulator, so the opening bytes can land while `term` is still null.
    const held = heldWrites()

    const write = (text: string): void => {
      held.write(text)
      outputRef.current?.(text)
    }

    // Says no once, in the pane. Deduplicated by reason, not keystroke: a held key
    // against a muted pane is one refusal repeated.
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

    // Keystrokes sent and unanswered. Counted, not guessed at: true whether the owner
    // is reading a prompt, the relay is slow, or their machine is busy.
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

    // Printed only when the wait was announced and the last of the burst settles.
    // Said for a landed keystroke too: a password prompt echoes nothing.
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

    // Not awaited and not queued: the transport writes frames in `call` order and this
    // handler is synchronous, so keys arrive in the order they were pressed.
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

    // Ended stays ended: a `lost` can arrive while still "Opening…", and the
    // continuation below must not overwrite the reason with `watching`.
    const end = (reason: string): void => {
      if (!alive) return
      setState((current) => (current.phase === 'ended' ? current : { phase: 'ended', reason }))
    }

    /** Said once: a peer that is sending nonsense tends to keep sending it. */
    let saidUnreadable = false

    const onEvent = (incoming: WatchedPaneEvent): void => {
      if (!alive) return
      // Nothing between their machine and here has checked the shape yet.
      const event = readWatchedPaneEvent(incoming)
      if (event === null) {
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
        // In the stream, at the point of the hole.
        held.write(`\r\n${DIM}[${event.bytes} bytes skipped: this pane is outrunning the relay]${RESET}\r\n`)
        return
      }
      if (event.type === 'lost') {
        // Told in the pane and on the header: a viewer that stopped updating reads as a quiet teammate.
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

        // The answer is a read of the owner's pty taken at `openedAt`; only presence heard since may move it.
        const showing = resizeWatchedPane(sizeRef.current, openedAt, opened) ?? {
          cols: opened.cols,
          rows: opened.rows
        }

        term = new XTerm({
          allowProposedApi: true,
          convertEol: false,
          // The cursor is the owner's, drawn in the bytes they send.
          cursorBlink: false,
          cursorInactiveStyle: 'none',
          // From the refs: this effect is keyed on the pane, and the emulator must not be rebuilt for a preference.
          fontFamily: fontFamilyRef.current,
          fontSize: fontSizeRef.current,
          lineHeight: 1.25,
          scrollback: 5000,
          theme: readTerminalTheme(document.documentElement),
          // The owner's, and never this window's. It moves when theirs does.
          cols: showing.cols,
          rows: showing.rows
        })
        term.open(host)
        // App chords reach the window handler, not the far end. Deliberately nothing
        // more: no `paneKeyHandler` clipboard chords (the interrupt half would be a
        // keystroke on their machine) and no clickable links — `docs/renderer-boundary.md`.
        term.attachCustomKeyEventHandler((event) => !chordRef.current(event))
        // Only bytes a person in this window produced; `handsHere` is the whole argument.
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
      // Closing the subscription is what tells the owner's runtime to stop streaming.
      subscription?.close()
      webgl?.dispose()
      term?.dispose()
    }
  }, [handle, paneId, projectId])

  // Follows the owner's pane when it changes shape. Keyed on presence because the
  // stream has no resize event; resizing in place keeps the scrollback.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resizeWatchedPane(size, openedAtRef.current, { cols: term.cols, rows: term.rows })
    if (next === null) return
    term.resize(next.cols, next.rows)
    refitRef.current?.()
    setState((current) => (current.phase === 'watching' ? { phase: 'watching', ...next } : current))
  }, [size])

  // Follows the reader's text size; the letterboxing rescales and their pty never
  // hears about it. First run is a no-op: the emulator was built at this size.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (term === null || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    refitRef.current?.()
  }, [fontSize])

  useEffect(() => {
    fontFamilyRef.current = fontFamily
    const term = termRef.current
    if (term === null || term.options.fontFamily === fontFamily) return
    term.options.fontFamily = fontFamily
    refitRef.current?.()
  }, [fontFamily])

  // Repaints when the palette moves: xterm cannot read CSS. Read off the document
  // after `App` has written it — that write is a *layout* effect; React flushes
  // passive effects child-first, so a plain `useEffect` there would land after this.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = readTerminalTheme(document.documentElement)
  }, [appearance])

  // Keeps the keyboard where the focused border says it is, as `TerminalView` does.
  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused, paneId])

  // On the bar and as its title, so a narrow slot cannot ellipsise the fact away.
  const promise = `what you type runs on ${handle}’s machine, as ${handle}, once they allow it, with your name on it`

  return (
    /* The chrome every pane has; what keeps it unmistakable is on the bar and in the accent. */
    <section
      className={`pane pane--watched${focused ? ' pane--focused' : ''}`}
      aria-label={`${handle}’s pane ${label}, which you can type into`}
      onFocus={onFocus}
      onMouseDown={onFocus}
    >
      <header className="pane__bar pane__bar--watched" title={promise}>
        <span className="watch__owner">{handle}</span>
        <span className="pane__title">{label}</span>
        {/* Said in words, at all times: nothing here may be ambiguous to the typist. */}
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
        <button
          type="button"
          className="pane__close"
          title={`Stop watching ${handle}’s ${label}`}
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
 * What a teammate's last presence says one of their panes measures. Null when
 * they send none (a peer not yet rebuilt carries no dimensions): never a guess.
 */
export function watchedPaneSize(presence: TeammatePresence | undefined, paneId: string): WatchedPaneSize | null {
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
 * The size to move a watched pane to, or null to leave it. `openedAt` breaks the
 * tie by age: presence heard before the watch was asked for is an older read of
 * the same pty, and adopting it would walk a freshly opened pane backwards.
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
 * One frame off a teammate's link, or nothing. `paneWatch` re-emits peer frames
 * unchecked, so this is the only place the shape is checked before `term.write`.
 * Rebuilt from the checked fields so nothing else in the payload rides in.
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

/** Writes held, in order, until there is a terminal to write them to. */
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
