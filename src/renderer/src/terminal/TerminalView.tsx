// One xterm instance, owned for exactly as long as the pane is mounted. React
// remounts panes on split changes and StrictMode doubles effects, so `alive`
// discards async results after teardown or a remount would attach two streams.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { IDisposable, ILinkHandler, ITerminalOptions } from '@xterm/xterm'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { PaneTypist } from '@shared/entities'
import type { TerminalEvent } from '@shared/methods'
import { copyText, pasteText } from '../clipboard/clipboard'
import {
  detectPlatform,
  holdsModifier,
  resolvePlatformModifier,
  type ModifierState,
  type PlatformModifier
} from '../keyboard/platformModifier'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { openInBrowser } from '../shell/openInBrowser'
import { agoLabel, typedBy, watchedBy } from '../sidebar/agentRows'
import { hasBeenTyped, paneAttention, typingNow, type PaneAttention } from '../state/paneAttention'
import type { TerminalOptions } from '../state/preferences'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { handsHere } from './handsHere'
import { frameWrites, paneWebgl, syncScrollbarPerFrame } from './paneFrames'
import { EMPTY_PANE_SEARCH, paneSearchReducer, SEARCH_HIGHLIGHT_LIMIT, toFindOptions } from './paneSearchModel'
import { TerminalSearchBar } from './TerminalSearchBar'
import { showPane } from './shownPanes'
import { TERMINAL_LINE_HEIGHT } from './paneMetrics'
import { readSearchDecorations, readTerminalColors } from './terminalTheme'

type TerminalViewProps = {
  terminalId: string
  focused: boolean
  onFocus: () => void
  /** Chords the app owns; xterm must not swallow them. */
  isAppChord: (event: KeyboardEvent) => boolean
  searchOpen: boolean
  /** Bumped on every press of the find chord, so a repeat press reclaims the field. */
  searchToken: number
  onCloseSearch: () => void
}

export function TerminalView({
  terminalId,
  focused,
  onFocus,
  isAppChord,
  searchOpen,
  searchToken,
  onCloseSearch
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // Kept so a font size applied after the pane was built can refit it.
  const fitRef = useRef<FitAddon | null>(null)
  // Filled in from the live palette when the terminal is created.
  const decorationsRef = useRef(readSearchDecorations(null))
  const chordRef = useRef(isAppChord)
  chordRef.current = isAppChord
  // Which key means "the app modifier" here, off the same functions `App` reads it with.
  const modifierRef = useRef<PlatformModifier>(
    resolvePlatformModifier(
      detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent)
    )
  )
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  // Seeded from the store so a pane created under a preference opens at it
  // rather than flickering from the default.
  const fontSizeRef = useRef(useWorkspaceStore.getState().terminalFontSize)
  const optionsRef = useRef(useWorkspaceStore.getState().terminalOptions)
  const [search, dispatch] = useReducer(paneSearchReducer, EMPTY_PANE_SEARCH)

  const watchers = useWorkspaceStore((state) => state.watchers)
  const attention = useMemo(() => paneAttention(watchers, terminalId), [watchers, terminalId])
  // Only a touched pane pays for the fast clock; a five-second tick would outlive the typing.
  const now = useNow(attention.typists.length > 0 ? TYPING_TICK_MS : undefined)
  const typing = useMemo(() => typingNow(attention.typists, now), [attention.typists, now])
  const mutePane = useWorkspaceStore((state) => state.mutePane)
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  // Read live so a size change in settings reaches panes that have been running for hours.
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const terminalOptions = useWorkspaceStore((state) => state.terminalOptions)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let alive = true
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorInactiveStyle: 'none',
      // From the refs: this effect is keyed on the terminal id alone, and a
      // preference change must not rebuild the emulator.
      fontSize: fontSizeRef.current,
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: 0,
      ...emulatorOptions(optionsRef.current),
      ...readTerminalColors(document.documentElement),
      // OSC 8 hyperlinks (`gh`, `npm`) come from xterm's own provider. Without
      // this xterm asks in a `confirm()` and calls `window.open()` with no URL,
      // which the main process denies. See PANE_LINK_HANDLER.
      linkHandler: PANE_LINK_HANDLER
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit

    // Bare URLs in the output are inert until this addon; it matches only
    // `http:` and `https:`, the set the main process hands the OS.
    term.loadAddon(paneLinkAddon())

    // The limit is shared with the counter, so "1000+" means where the addon stopped looking.
    decorationsRef.current = readSearchDecorations(document.documentElement)
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
    term.loadAddon(searchAddon)
    searchRef.current = searchAddon
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (alive) dispatch({ type: 'results', resultIndex, resultCount })
    })

    term.open(host)
    const unshow = showPane(terminalId, term)
    copyOnSelect(term, () => optionsRef.current.copyOnSelect, copyText)

    const gpu = paneWebgl(term)
    const scrollbar = syncScrollbarPerFrame(term)
    const output = frameWrites((data) => term.write(data))

    // Said once: an exited pane does not un-exit, and a line per keystroke
    // would bury the scrollback.
    let saidExited = false

    /**
     * Bytes on their way to the pty. `byHand` travels with them because only
     * this window can tell a device-query reply from typing. See `handsHere.ts`.
     */
    const send = (data: string, byHand = true): void => {
      void runtimeClient.call('terminal.write', { terminalId, data, byHand }).catch((error: unknown) => {
        const notice = refusedWriteNotice(error)
        if (notice === null || saidExited || !alive) return
        saidExited = true
        output.flush()
        term.write(notice)
      })
    }

    const hands = handsHere(term.element)

    term.attachCustomKeyEventHandler(
      paneKeyHandler({
        isAppChord: (event) => chordRef.current(event),
        term,
        modifier: modifierRef.current,
        send,
        // The clipboard read a paste chord waits on outlives the keypress, so
        // the person behind it has to be vouched for rather than observed.
        byHand: hands.mark
      })
    )

    term.onData((data) => send(data, hands.acting()))
    term.onResize(({ cols, rows }) => {
      void runtimeClient
        .call('terminal.resize', { terminalId, cols, rows })
        // The pane header reports the size the runtime actually applied.
        .then((record) => useWorkspaceStore.getState().recordTerminal(record))
        .catch(() => {})
    })

    // Subscribe before reading the snapshot so no byte is lost in between;
    // bytes arriving while it is in flight are replayed in order.
    const pending: string[] = []
    let replaying = true
    let subscription: { close(): void } | null = null

    const onEvent = (event: TerminalEvent): void => {
      if (!alive) return
      if (event.type === 'data') {
        if (replaying) pending.push(event.data)
        else output.push(event.data)
      } else if (event.type === 'exit') {
        output.flush()
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
        for (const chunk of pending.splice(0)) output.push(chunk)
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
        gpu.retry()
        try {
          fit.fit()
        } catch {
          // A pane detached mid-frame has no dimensions to fit to.
        }
      })
    }

    /**
     * The first fit, now rather than next frame: a full-screen agent draws every
     * frame at whatever size it was last told. Sent even when the fit moved
     * nothing, because xterm raises `onResize` only on a change.
     */
    const fitOnMount = (): void => {
      if (!alive || host.clientWidth === 0 || host.clientHeight === 0) return
      const before = `${term.cols}x${term.rows}`
      try {
        fit.fit()
      } catch {
        return
      }
      if (`${term.cols}x${term.rows}` !== before) return
      void runtimeClient
        .call('terminal.resize', { terminalId, cols: term.cols, rows: term.rows })
        .then((record) => useWorkspaceStore.getState().recordTerminal(record))
        .catch(() => {})
    }

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    fitOnMount()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') gpu.retry()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      alive = false
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      subscription?.close()
      hands.stop()
      output.dispose()
      scrollbar.dispose()
      gpu.dispose()
      unshow()
      term.dispose()
      termRef.current = null
      searchRef.current = null
      fitRef.current = null
    }
  }, [terminalId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused, terminalId])

  // A new size changes how many columns fit and the shell is still writing for
  // the old ones; the refit's `onResize` sends `terminal.resize`. The first run
  // is a no-op: xterm ignores a write of the value it already holds.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    try {
      fitRef.current?.fit()
    } catch {
      // No box to measure yet; the resize observer refits it as soon as there is one.
    }
  }, [fontSize])

  // Scrollback too: xterm resizes the buffer in place, trimming only the oldest lines when it shrinks.
  useEffect(() => {
    optionsRef.current = terminalOptions
    const term = termRef.current
    if (!term || !applyEmulatorOptions(term, terminalOptions)) return
    try {
      fitRef.current?.fit()
    } catch {
      // As for the size: the resize observer refits it once there is a box.
    }
  }, [terminalOptions])

  // Reads the custom properties back off the document after `App` has written
  // them — that write is a *layout* effect; React flushes passive effects
  // child-first, so a plain `useEffect` there would leave panes a theme behind.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    Object.assign(term.options, readTerminalColors(document.documentElement))
    decorationsRef.current = readSearchDecorations(document.documentElement)
  }, [appearance, systemTone])

  // Re-running on every keystroke keeps the counter live; `incremental` keeps
  // the current selection so the viewport does not hop between matches.
  useEffect(() => {
    const addon = searchRef.current
    if (!addon || !searchOpen) return
    if (search.query === '') {
      addon.clearDecorations()
      return
    }
    addon.findNext(search.query, toFindOptions(search.options, decorationsRef.current, true))
  }, [search.query, search.options, searchOpen])

  const step = useCallback(
    (direction: 'next' | 'previous') => {
      const addon = searchRef.current
      if (!addon || search.query === '') return
      // Stepping is deliberately not incremental: it has to leave the match it
      // is on, which is the one thing incremental mode refuses to do.
      const options = toFindOptions(search.options, decorationsRef.current, false)
      if (direction === 'next') addon.findNext(search.query, options)
      else addon.findPrevious(search.query, options)
    },
    [search.query, search.options]
  )

  const searchWasOpen = useRef(false)
  useEffect(() => {
    const wasOpen = searchWasOpen.current
    searchWasOpen.current = searchOpen
    if (searchOpen || !wasOpen) return
    searchRef.current?.clearDecorations()
    dispatch({ type: 'reset' })
    // The focus effect only fires when focus moves. A pane that lost the bar
    // to another pane must not pull focus out of that pane's field.
    if (focusedRef.current) termRef.current?.focus()
  }, [searchOpen])

  // The bar floats over the terminal: a row of its own would refit the PTY
  // and make the running program redraw itself just to be searched.
  return (
    <div className="terminal-frame">
      {attention.muted || hasBeenTyped(attention) || attention.watchers.length > 0 ? (
        <div className={`pane-hands${typing.length > 0 ? ' pane-hands--typing' : ''}`}>
          {/* Named, present tense, only while true: somebody else's shell here cannot be used quietly. */}
          <span className="pane-hands__who" title={attributionTitle(attention, typing)}>
            {typing.length > 0
              ? typedBy(typing)
              : hasBeenTyped(attention)
                ? typedHere(attention.typists, now)
                : watchedBy(attention.watchers)}
          </span>
          <button
            type="button"
            className={`button button--ghost button--tiny${attention.muted ? ' pane-hands__mute--on' : ''}`}
            title={muteTitle(attention.muted)}
            onClick={() => void mutePane(terminalId, !attention.muted)}
          >
            {attention.muted ? 'Muted' : 'Mute'}
          </button>
        </div>
      ) : null}
      {searchOpen ? (
        <TerminalSearchBar
          state={search}
          focusToken={searchToken}
          onQueryChange={(value) => dispatch({ type: 'query', value })}
          onToggle={(option) => dispatch({ type: 'toggle', option })}
          onStep={step}
          onClose={onCloseSearch}
        />
      ) : null}
      <div className="terminal-surface" ref={hostRef} onFocus={onFocus} onMouseDown={onFocus} />
    </div>
  )
}

/** While somebody is typing the clock has to keep up with them. */
const TYPING_TICK_MS = 1_000

/** Past tense, and with the age on it, so an old fact cannot read as a new one. */
function typedHere(typists: readonly PaneTypist[], now: number): string {
  const latest = typists.reduce<PaneTypist | undefined>(
    (newest, typist) => (newest === undefined || typist.at > newest.at ? typist : newest),
    undefined
  )
  return latest === undefined ? '' : `${latest.handle} typed here ${agoLabel(now - latest.at)}`
}

/** The mute button's tooltip: the state when muted, the action when not. */
export function muteTitle(muted: boolean): string {
  return muted ? 'Muted for teammates' : 'Mute for teammates'
}

/** On hover: who, how many keystrokes and bytes, and what this machine refused. */
function attributionTitle(attention: PaneAttention, typing: readonly PaneTypist[]): string {
  const lines = attention.typists.map((typist) => {
    const refused = typist.refused > 0 ? `, ${typist.refused} refused` : ''
    const live = typing.some((who) => who.publicKey === typist.publicKey) ? ' · typing now' : ''
    return `${typist.handle}: ${typist.writes} keystroke${
      typist.writes === 1 ? '' : 's'
    }, ${typist.bytes} bytes${refused}${live}`
  })
  if (attention.watchers.length > 0) lines.push(watchedBy(attention.watchers))
  if (attention.muted) lines.push('muted for teammates')
  return lines.join('\n')
}

/**
 * What a refused keystroke puts in the pane, or null. Only an exited pane is
 * worth printing, in the exit line's register. Branches on the code, never the
 * message: `conflict` is the runtime's answer for an exited terminal.
 */
export function refusedWriteNotice(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code !== 'conflict') return null
  return '\r\n\u001b[38;5;244m[this pane has exited]\u001b[0m\r\n'
}

/** The preferences xterm reads, in its own names. */
export function emulatorOptions(options: TerminalOptions): ITerminalOptions {
  return {
    fontFamily: options.fontFamily,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    macOptionIsMeta: options.optionIsMeta,
    scrollback: options.scrollback
  }
}

/** Writes only what changed into a running emulator; true when the font moved and the pane needs a refit. */
export function applyEmulatorOptions(term: Pick<XTerm, 'options'>, options: TerminalOptions): boolean {
  const next = emulatorOptions(options)
  const fontMoved = term.options.fontFamily !== next.fontFamily
  for (const [key, value] of Object.entries(next) as [keyof ITerminalOptions, unknown][]) {
    if (term.options[key] !== value) Object.assign(term.options, { [key]: value })
  }
  return fontMoved
}

/** Copies each new selection while `enabled` says so; a cleared selection copies nothing. */
export function copyOnSelect(
  term: Pick<XTerm, 'onSelectionChange' | 'hasSelection' | 'getSelection'>,
  enabled: () => boolean,
  copy: (text: string) => void
): IDisposable {
  return term.onSelectionChange(() => {
    if (!enabled() || !term.hasSelection()) return
    const text = term.getSelection()
    if (text !== '') copy(text)
  })
}

/** The byte a terminal sends for "stop what you are doing". */
const INTERRUPT = '\u0003'

/** Opens a link a pane printed in the browser, never in this window. See `openInBrowser.ts` for why there is one of it. */
export const openPaneLink = openInBrowser

/** A click on an OSC 8 hyperlink does what a click on a bare URL does; xterm only offers `http:`/`https:` ones. */
export const PANE_LINK_HANDLER: ILinkHandler = {
  activate: (_event, text) => openPaneLink(text)
}

/** The addon that turns a bare URL in the scrollback into something clickable. */
export function paneLinkAddon(): WebLinksAddon {
  return new WebLinksAddon((_event, uri) => openPaneLink(uri))
}

/** Everything the key handler below is allowed to touch. */
export type PaneKeys = {
  /** Chords the app owns. Refused here, and answered by the window handler. */
  isAppChord: (event: KeyboardEvent) => boolean
  /** The emulator: what is selected, and where a paste goes in. */
  term: Pick<XTerm, 'hasSelection' | 'getSelection' | 'paste'>
  modifier: PlatformModifier
  /** Bytes to the pty. */
  send: (data: string) => void
  /** Vouches for a paste, which lands a turn after the chord and goes in through the emulator. See `handsHere.ts`. */
  byHand?: () => void
  /** The system clipboard, injected so a test can watch it. */
  clipboard?: { copy: (text: string) => void; read: () => Promise<string> }
}

/**
 * The pane's answer to one keypress, as xterm's custom key handler wants it:
 * `true` to let the emulator have it, `false` to keep it. App chords first, then
 * the clipboard pair, then the emulator. On macOS the Edit menu claims these
 * accelerators before the page; the branch it loses is in `src/main/appMenu.ts`.
 */
export function paneKeyHandler(keys: PaneKeys): (event: KeyboardEvent) => boolean {
  const clipboard = keys.clipboard ?? { copy: copyText, read: pasteText }
  return (event) => {
    if (keys.isAppChord(event)) return false
    const intent = paneKeyIntent(event, keys.modifier, keys.term.hasSelection())
    if (intent === 'emulator') return true
    // One press raises keydown, keypress and keyup. Act on the keydown alone;
    // keep the other two from the emulator too, since half a chord is worse than none.
    if (event.type !== 'keydown') return false
    if (intent === 'copy') clipboard.copy(keys.term.getSelection())
    else if (intent === 'interrupt') keys.send(INTERRUPT)
    else {
      void clipboard.read().then((text) => {
        if (text === '') return
        try {
          // Through the emulator: `paste` adds the bracketed-paste markers the program asked for.
          keys.byHand?.()
          keys.term.paste(text)
        } catch {
          // The clipboard read takes a turn of the loop; the pane may have closed underneath it.
        }
      })
    }
    return false
  }
}

/**
 * Who a keypress belongs to once the app's chords have had it. The copy chord
 * is two commands: with a selection it copies, without one it is the interrupt.
 * Only where the modifier is the command key (macOS); elsewhere Ctrl+C is the
 * interrupt itself and must never be lost.
 */
export type PaneKeyIntent = 'copy' | 'interrupt' | 'paste' | 'emulator'

export function paneKeyIntent(
  event: ModifierState & { key: string },
  modifier: PlatformModifier,
  hasSelection: boolean
): PaneKeyIntent {
  if (modifier.eventFlag !== 'metaKey') return 'emulator'
  if (!holdsModifier(event, modifier) || event.shiftKey || event.altKey) return 'emulator'
  const key = event.key.toLowerCase()
  if (key === 'c') return hasSelection ? 'copy' : 'interrupt'
  if (key === 'v') return 'paste'
  return 'emulator'
}
