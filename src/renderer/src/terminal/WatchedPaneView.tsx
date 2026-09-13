// A teammate's pane, open for reading and for nothing else.
//
// This is deliberately NOT `TerminalView` with a flag. A pane you can type into
// and a pane you are reading over somebody's shoulder are two different objects
// in the world, and the differences are structural rather than cosmetic:
//
// **There is no write path at all.** No `onData` handler is attached, xterm is
// created with `disableStdin`, and the method that would carry a keystroke is
// not on the teammate's allow-list. A watcher's keys reach nothing, and the
// surface says so in words rather than by looking greyed out — a disabled
// control is a thing that would work if something were different, and this is a
// thing that will not until milestone D exists.
//
// **The size is the owner's.** `docs/teamwork.md` is explicit: a watcher with a
// smaller window is letterboxed rather than resizing a pty under a program that
// is only being read. So the emulator is built at the owner's columns and rows
// and never refits; the whole picture is scaled down to fit the viewer, with
// bars where it does not reach. Scaling is a CSS transform, which touches
// nothing on the far machine.
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
          // The whole of the read-only guarantee that xterm itself can make.
          // The rest of it is that nothing below ever attaches `onData`, and
          // that `terminal.write` is not a method a teammate may call.
          disableStdin: true,
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
    <section className="watch" aria-label={`${handle}’s pane ${label}, read only`}>
      <header className="watch__head">
        <span className="watch__title">
          <span className="watch__owner">{handle}</span>
          <span className="watch__label">{label}</span>
        </span>
        {/* Said in words, on the pane, at all times. The design's argument for
            why any of this is survivable is that nothing is ambiguous. */}
        <span className="watch__readonly">reading only — you cannot type here</span>
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
