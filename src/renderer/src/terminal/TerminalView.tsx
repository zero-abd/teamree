// One xterm instance, owned for exactly as long as the pane is mounted.
//
// The lifecycle is the delicate part: React remounts panes whenever the split
// tree is rearranged, and StrictMode runs every effect twice in development.
// So the effect owns creation, subscription and teardown together, and an
// `alive` flag discards any async result that lands after teardown — otherwise
// a remount would attach a second stream and every byte would appear twice.

import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { readTerminalTheme, TERMINAL_FONT_FAMILY } from './terminalTheme'

type TerminalViewProps = {
  terminalId: string
  focused: boolean
  onFocus: () => void
  /** Chords the app owns; xterm must not swallow them. */
  isAppChord: (event: KeyboardEvent) => boolean
}

export function TerminalView({ terminalId, focused, onFocus, isAppChord }: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const chordRef = useRef(isAppChord)
  chordRef.current = isAppChord

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let alive = true
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      theme: readTerminalTheme(document.documentElement),
      // The app's chords reach the window handler instead of the emulator.
      macOptionIsMeta: false
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // WebGL is the fast path; a machine without a working context simply keeps
    // the DOM renderer, and a lost context tears the addon back down.
    let webgl: WebglAddon | null = null
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

    term.attachCustomKeyEventHandler((event) => !chordRef.current(event))
    term.onData((data) => {
      void runtimeClient.call('terminal.write', { terminalId, data }).catch(() => {})
    })
    term.onResize(({ cols, rows }) => {
      void runtimeClient
        .call('terminal.resize', { terminalId, cols, rows })
        // The pane header reports the size the runtime actually applied.
        .then((record) => useWorkspaceStore.getState().recordTerminal(record))
        .catch(() => {})
    })

    // Subscribe before reading the snapshot so no byte is lost in between;
    // anything that arrives while the snapshot is in flight is held back and
    // replayed in order.
    const pending: string[] = []
    let replaying = true
    let subscription: { close(): void } | null = null

    const onEvent = (event: TerminalEvent): void => {
      if (!alive) return
      if (event.type === 'data') {
        if (replaying) pending.push(event.data)
        else term.write(event.data)
      } else if (event.type === 'exit') {
        term.write(`\r\n\u001b[38;5;244m[process exited with code ${event.exitCode}]\u001b[0m\r\n`)
      }
    }

    void runtimeClient
      .subscribeTerminal(terminalId, onEvent)
      .then((handle) => {
        if (!alive) {
          handle.close()
          return
        }
        subscription = handle
        return runtimeClient.call('terminal.read', { terminalId })
      })
      .then((snapshot) => {
        if (!alive || !snapshot) return
        term.write(snapshot.data)
        replaying = false
        for (const chunk of pending.splice(0)) term.write(chunk)
      })
      .catch(() => {
        replaying = false
      })

    // Fitting mid-layout-thrash is wasted work, so coalesce to one per frame.
    let frame = 0
    const scheduleFit = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!alive || host.clientWidth === 0 || host.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          // A pane detached mid-frame has no dimensions to fit to.
        }
      })
    }

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    scheduleFit()

    return () => {
      alive = false
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      subscription?.close()
      webgl?.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [terminalId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused, terminalId])

  return <div className="terminal-surface" ref={hostRef} onFocus={onFocus} onMouseDown={onFocus} />
}
