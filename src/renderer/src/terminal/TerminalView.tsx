// One xterm instance, owned for exactly as long as the pane is mounted.
//
// The lifecycle is the delicate part: React remounts panes whenever the split
// tree is rearranged, and StrictMode runs every effect twice in development.
// So the effect owns creation, subscription and teardown together, and an
// `alive` flag discards any async result that lands after teardown — otherwise
// a remount would attach a second stream and every byte would appear twice.
//
// THE BAR ACROSS THE TOP IS NOT DECORATION. A teammate can type into this pane,
// and their keystrokes run as this machine's user — once the owner has allowed
// them. The prompt that asks is a modal and is over in a moment; this bar is
// what is left afterwards, and `docs/teamwork.md` rests on it just as much:
// being asked once is not the same as knowing whose keystrokes are in your pane
// now. So the bar appears the moment somebody else's bytes land here, names them
// while they are typing, and carries the mute — which is instant, local, needs
// nobody's agreement, and lifts every permission on the pane with it. It stays
// after they stop, because a pane a teammate typed into an hour ago is not a
// pane whose history is the owner's alone, and it should not have to be
// remembered to be known.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { PaneTypist } from '@shared/entities'
import type { TerminalEvent } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { sinceLabel, typedBy, watchedBy } from '../sidebar/agentRows'
import { hasBeenTyped, paneAttention, typingNow, type PaneAttention } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { EMPTY_PANE_SEARCH, paneSearchReducer, SEARCH_HIGHLIGHT_LIMIT, toFindOptions } from './paneSearchModel'
import { TerminalSearchBar } from './TerminalSearchBar'
import { readSearchDecorations, readTerminalTheme, TERMINAL_FONT_FAMILY } from './terminalTheme'

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
  // Kept so a font size applied after the pane was built can refit it. The
  // addon is otherwise entirely the creation effect's business.
  const fitRef = useRef<FitAddon | null>(null)
  // Filled in from the live palette when the terminal is created; the fallback
  // only stands for the instant before that.
  const decorationsRef = useRef(readSearchDecorations(null))
  const chordRef = useRef(isAppChord)
  chordRef.current = isAppChord
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  // The size the next emulator is built at. Seeded from the store so a pane
  // created while a preference is already in force opens at it rather than
  // opening at the default and flickering to the right size.
  const fontSizeRef = useRef(useWorkspaceStore.getState().terminalFontSize)
  const [search, dispatch] = useReducer(paneSearchReducer, EMPTY_PANE_SEARCH)

  const watchers = useWorkspaceStore((state) => state.watchers)
  const attention = useMemo(() => paneAttention(watchers, terminalId), [watchers, terminalId])
  // Only a pane somebody has touched pays for the fast clock. A "is typing"
  // that ticked every five seconds would outlive the typing by four of them.
  const now = useNow(attention.typists.length > 0 ? TYPING_TICK_MS : undefined)
  const typing = useMemo(() => typingNow(attention.typists, now), [attention.typists, now])
  const mutePane = useWorkspaceStore((state) => state.mutePane)
  const appearance = useWorkspaceStore((state) => state.appearance)
  // Read here rather than baked into the emulator's options once, so that
  // changing the size in settings reaches panes that have been running for
  // hours. It is the same bargain the palette above it makes, and for the same
  // reason: a preference that only applied to panes opened after it was changed
  // would send people closing their work to see it take effect.
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)

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
      // `fontSizeRef` rather than `fontSize`, because this effect is keyed on
      // the terminal id alone: taking the size from the closure would make the
      // whole emulator — and its scrollback, and its subscription — a thing
      // that had to be torn down and rebuilt to change a number.
      fontSize: fontSizeRef.current,
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
    fitRef.current = fit

    // The limit is shared with the counter, so "1000+" means exactly the point
    // at which the addon stopped looking rather than a number of its own.
    decorationsRef.current = readSearchDecorations(document.documentElement)
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
    term.loadAddon(searchAddon)
    searchRef.current = searchAddon
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (alive) dispatch({ type: 'results', resultIndex, resultCount })
    })

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
    // Said once. A pane that has exited does not un-exit, no further output can
    // push the line out of sight, and a sentence per keystroke would bury the
    // scrollback somebody is still reading.
    let saidExited = false
    term.onData((data) => {
      void runtimeClient.call('terminal.write', { terminalId, data }).catch((error: unknown) => {
        const notice = refusedWriteNotice(error)
        if (notice === null || saidExited || !alive) return
        saidExited = true
        term.write(notice)
      })
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
      searchRef.current = null
      fitRef.current = null
    }
  }, [terminalId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused, terminalId])

  // A new size is not just a repaint: a cell got bigger or smaller, so the same
  // box now holds a different number of columns and rows, and the shell on the
  // other end is still writing for the old ones. Refitting is what tells it —
  // `fit()` resizes the emulator, the emulator's own `onResize` above sends
  // `terminal.resize` to the runtime, and the PTY learns its new geometry. Skip
  // the refit and an agent's output wraps against a width nothing has any more.
  //
  // The first run of this effect is a no-op by construction: the emulator was
  // created at exactly this size a moment ago, and xterm ignores a write of the
  // value it already holds.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    try {
      fitRef.current?.fit()
    } catch {
      // A pane with no box to measure — mid-layout, or detached — keeps the new
      // size and is refitted by the resize observer as soon as it has one.
    }
  }, [fontSize])

  // The palette changed, so the emulator's copy of it has to. This reads the
  // custom properties back off the document rather than taking the appearance
  // apart itself, which is what keeps one derivation behind both the chrome and
  // the panes — and it runs after `App` has written them because that write is
  // a *layout* effect. Being above this one in the tree is not what puts it
  // first; React flushes passive effects child-first, so a plain `useEffect`
  // there would land after this one and every pane would repaint itself in the
  // theme before last.
  //
  // Without it, switching a theme repainted the window around panes that stayed
  // the colour they were created in, and the only way to bring them over was to
  // close and reopen every one.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = readTerminalTheme(document.documentElement)
    decorationsRef.current = readSearchDecorations(document.documentElement)
  }, [appearance])

  // Re-running the search on every keystroke is what makes the counter live,
  // and `incremental` keeps the current selection while the term is still
  // growing, so the viewport does not hop between matches as the user types.
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
    // Nothing else gives the keyboard back, since the focus effect above only
    // fires when focus moves. A pane that lost the bar to another pane is no
    // longer the focused one, and must not pull focus out of that pane's field.
    if (focusedRef.current) termRef.current?.focus()
  }, [searchOpen])

  // The bar floats over the terminal rather than taking a row of its own:
  // anything that changes the surface's height refits it, which resizes the
  // PTY and makes the running program redraw itself just to be searched.
  return (
    <div className="terminal-frame">
      {attention.muted || hasBeenTyped(attention) || attention.watchers.length > 0 ? (
        <div className={`pane-hands${typing.length > 0 ? ' pane-hands--typing' : ''}`}>
          {/* Named and in the present tense, and only while it is true. The
              whole of what makes somebody else's shell on this machine
              survivable is that it cannot be used quietly. */}
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
            title={
              attention.muted
                ? 'Teammates cannot type into this pane. They can still read it.'
                : 'Stop teammates typing into this pane. It stays visible to them.'
            }
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
  return latest === undefined ? '' : `${latest.handle} typed here ${sinceLabel(now - latest.at)} ago`
}

/**
 * The whole of it on hover: who, how much, and what this machine refused.
 *
 * The counts are the point. "ana is typing" says somebody is there; "ana — 61
 * keystrokes, 240 bytes" is what an owner reads when they come back to a pane
 * and want to know what happened to it.
 */
function attributionTitle(attention: PaneAttention, typing: readonly PaneTypist[]): string {
  const lines = attention.typists.map((typist) => {
    const refused = typist.refused > 0 ? `, ${typist.refused} refused` : ''
    const live = typing.some((who) => who.publicKey === typist.publicKey) ? ' · typing now' : ''
    return `${typist.handle}: ${typist.writes} keystroke${
      typist.writes === 1 ? '' : 's'
    }, ${typist.bytes} bytes${refused}${live}`
  })
  if (attention.watchers.length > 0) lines.push(watchedBy(attention.watchers))
  if (attention.muted) lines.push('muted: their keystrokes are refused, their reading is not')
  return lines.join('\n')
}

/**
 * What a refused keystroke puts in the pane, or null when there is nothing a
 * reader could do with the answer.
 *
 * The one refusal worth printing is the pane having exited: the cursor is still
 * there, the box still takes typing, and the runtime has been saying no to
 * every character since the process went. The exit line is already in the
 * buffer a few rows up, so this matches its register rather than raising an
 * alarm of its own — it is a reminder of a fact the pane has stated, not news.
 *
 * Branching on the code and never on the message, the way the transport asks:
 * `conflict` is what the runtime answers for a terminal that has exited, and
 * the sentence it carries is free to be reworded.
 */
export function refusedWriteNotice(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code !== 'conflict') return null
  return '\r\n\u001b[38;5;244m[this pane has exited]\u001b[0m\r\n'
}
