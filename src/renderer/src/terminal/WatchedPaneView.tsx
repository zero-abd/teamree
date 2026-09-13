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
// **The size is the owner's.** `docs/teamwork.md` is explicit: a watcher with a
// smaller window is letterboxed rather than resizing a pty under a program that
// is only being read. So the emulator is built at the owner's columns and rows
// and never refits; the whole picture is scaled down to fit the viewer, with
// bars where it does not reach. Scaling is a CSS transform, which touches
// nothing on the far machine. That stays true now that typing works: a
// keystroke is not a resize, and `terminal.resize` is still not a method a
// teammate may call.
//
// **The stream can be honest about its own gaps.** A local pane cannot lose
// output on the way to the screen. This one can — the relay has a budget and a
// chatty agent can beat it — and when that happens the notice is written into
// the pane, in place, where the missing output would have been.

import { useEffect, useRef, useState } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { WatchedPaneEvent } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
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

type WatchedPaneViewProps = {
  projectId: string
  /** The namespaced id `teamwork.presence` hands out, not the owner's own. */
  paneId: string
  /** What to call the pane in the header, as the sidebar already names it. */
  label: string
  handle: string
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
  onClose,
  onOutput
}: WatchedPaneViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<WatchState>({ phase: 'opening' })
  const [refused, setRefused] = useState<Refusal | null>(null)
  const outputRef = useRef(onOutput)
  outputRef.current = onOutput

  useEffect(() => {
    const host = hostRef.current
    const frame = frameRef.current
    if (!host || !frame) return

    let alive = true
    let term: XTerm | null = null
    let webgl: WebglAddon | null = null
    let subscription: { close: () => void } | null = null
    let observer: ResizeObserver | null = null

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

    const write = (text: string): void => {
      term?.write(text)
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
      term?.write(`\r\n${WARN}[not typed: ${reason}]${RESET}\r\n`)
      setRefused(last)
    }

    /** Typing is working again, so the header must stop saying it is not. */
    const accepted = (): void => {
      if (!alive || last === null) return
      last = null
      setRefused(null)
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
      void runtimeClient.call('teamwork.type', { projectId, paneId, data }).then(accepted, (error: unknown) => {
        refuse(error instanceof Error ? error.message : String(error))
      })
    }

    const onEvent = (event: WatchedPaneEvent): void => {
      if (!alive) return
      if (event.type === 'data') {
        write(event.data)
        return
      }
      if (event.type === 'exit') {
        term?.write(`\r\n${DIM}[their process exited with code ${event.exitCode}]${RESET}\r\n`)
        return
      }
      if (event.type === 'elided') {
        // In the stream, at the point of the hole. A viewer that quietly
        // skipped the bytes would be showing a transcript that never happened.
        term?.write(`\r\n${DIM}[${event.bytes} bytes skipped: this pane is outrunning the relay]${RESET}\r\n`)
        return
      }
      if (event.type === 'lost') {
        // Whatever ended it — their machine, their pane, or the relay — the
        // reader is told in the pane and on the header, because a viewer that
        // simply stopped updating reads as a teammate who went quiet.
        term?.write(`\r\n${DIM}[stopped watching: ${event.reason}]${RESET}\r\n`)
        setState({ phase: 'ended', reason: event.reason })
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

        term = new XTerm({
          allowProposedApi: true,
          convertEol: false,
          // The cursor is the owner's and is drawn by their pty in the bytes
          // they send. A second one blinking here would be this window's guess
          // at where the far end's is, which is a thing it cannot know.
          cursorBlink: false,
          cursorInactiveStyle: 'none',
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 5000,
          theme: readTerminalTheme(document.documentElement),
          // The owner's, and never changed from here.
          cols: opened.cols,
          rows: opened.rows
        })
        term.open(host)
        term.onData(send)

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
        setState({ phase: 'watching', cols: opened.cols, rows: opened.rows })
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState({ phase: 'ended', reason: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      alive = false
      observer?.disconnect()
      // The bytes stop here. Closing the subscription is what tells the owner's
      // runtime to stop streaming, which is the whole of "bytes flow on demand".
      subscription?.close()
      webgl?.dispose()
      term?.dispose()
    }
  }, [handle, paneId, projectId])

  return (
    <section className="watch" aria-label={`${handle}’s pane ${label}, which you can type into`}>
      <header className="watch__head">
        <span className="watch__title">
          <span className="watch__owner">{handle}</span>
          <span className="watch__label">{label}</span>
        </span>
        {/* Said in words, on the pane, at all times, and said about the person
            reading it rather than about the feature. The design's argument for
            why any of this is survivable is that nothing is ambiguous — and
            that includes being unambiguous with the person doing the typing
            about the fact that their name is on it. */}
        <span className={`watch__typing${refused ? ' watch__typing--refused' : ''}`}>
          {refused ? refused.reason : `what you type runs on ${handle}’s machine, as ${handle}, with your name on it`}
        </span>
        {state.phase === 'watching' ? (
          <span className="watch__size" title="their pane’s size, which a reader never changes">
            {`${state.cols}×${state.rows}`}
          </span>
        ) : null}
        <button type="button" className="button button--ghost watch__close" onClick={onClose}>
          Stop watching
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
