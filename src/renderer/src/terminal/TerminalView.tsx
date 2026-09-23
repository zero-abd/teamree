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
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ILinkHandler } from '@xterm/xterm'
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
import { sinceLabel, typedBy, watchedBy } from '../sidebar/agentRows'
import { hasBeenTyped, paneAttention, typingNow, type PaneAttention } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { handsHere } from './handsHere'
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
  // Which key means "the app modifier" here, off the same two functions `App`
  // reads it with. Derived rather than passed down because this is the only
  // pane prop that would have had to be threaded through the whole split tree
  // to reach one key handler, and the derivation is a lookup on a constant.
  const modifierRef = useRef<PlatformModifier>(
    resolvePlatformModifier(
      detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent)
    )
  )
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
      // An OSC 8 hyperlink — the kind `gh` and `npm` print, where the URL is in
      // the escape sequence and the text on screen is a label — is offered by
      // xterm's own provider and activated through this. Without it xterm asks
      // "Do you want to navigate to …?" in a `confirm()` and then calls
      // `window.open()` with no URL at all, so the answer is a blank window
      // request the main process denies and a warning in a console nobody is
      // reading. See PANE_LINK_HANDLER.
      linkHandler: PANE_LINK_HANDLER,
      // The app's chords reach the window handler instead of the emulator.
      macOptionIsMeta: false
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit

    // A bare URL in the output — the one an agent prints when it opens a pull
    // request, the one CI prints when it fails — is a run of characters and
    // nothing else until this addon looks at it. It only ever matches `http:`
    // and `https:`, which is the same set the main process will hand the OS.
    term.loadAddon(paneLinkAddon())

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

    // Said once. A pane that has exited does not un-exit, no further output can
    // push the line out of sight, and a sentence per keystroke would bury the
    // scrollback somebody is still reading.
    let saidExited = false

    /**
     * Bytes on their way to the pty, and the one door they leave by.
     *
     * `byHand` travels with them because the runtime cannot work it out and
     * this window can: an emulator answers the program's device queries by
     * sending bytes down this same door, and a write the runtime reads as
     * typing is a pane recorded as having a conversation in it. Defaults to a
     * person, so the only bytes that have to prove themselves are the ones
     * nobody pressed. See `handsHere.ts`.
     */
    const send = (data: string, byHand = true): void => {
      void runtimeClient.call('terminal.write', { terminalId, data, byHand }).catch((error: unknown) => {
        const notice = refusedWriteNotice(error)
        if (notice === null || saidExited || !alive) return
        saidExited = true
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
        // The clipboard read that a paste chord waits on outlives the keypress
        // that asked for it, so the person behind it has to be vouched for
        // rather than observed.
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
      hands.stop()
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

/** The byte a terminal sends for "stop what you are doing". */
const INTERRUPT = '\u0003'

/**
 * Opens a link a pane printed, in the browser and never in this window.
 *
 * The same call every other link in the window makes — see
 * `src/renderer/src/shell/openInBrowser.ts` for why there is exactly one of it.
 */
export const openPaneLink = openInBrowser

/**
 * What a click on an OSC 8 hyperlink does.
 *
 * The same thing a click on a bare URL does, which is the point of it being one
 * object. xterm offers these links only when the URL in the sequence parses as
 * `http:` or `https:`, so nothing else reaches here from that direction.
 */
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
  /**
   * Says that the write about to happen is this person's, for the one branch
   * here that cannot be seen to be: a paste arrives from the clipboard a turn
   * of the loop after the chord that asked for it, and goes in through the
   * emulator, so nothing is in flight to connect the two. See `handsHere.ts`.
   */
  byHand?: () => void
  /**
   * The system clipboard. Injected because a test that could not watch it
   * would be asserting the intent again rather than the thing that happens.
   */
  clipboard?: { copy: (text: string) => void; read: () => Promise<string> }
}

/**
 * The pane's answer to one keypress, as xterm's custom key handler wants it:
 * `true` to let the emulator have it, `false` to keep it.
 *
 * Three layers want the press and exactly one of them may have it. The app's
 * own chords go first and are answered by the window, as they always were. Then
 * the clipboard pair, which the emulator has no answer for and which would
 * otherwise be nobody's. Everything else is the emulator's, which is to say the
 * program's.
 *
 * There is a fourth layer above all of them on macOS and it is not in this
 * file: the Edit menu's Copy and Paste carry these accelerators, and a menu key
 * equivalent is performed before the keystroke reaches the page. So on a Mac
 * this rule is reached where the menu does not claim the chord, and the one
 * branch that is the menu's loss rather than its gain — a copy with nothing
 * selected, which a terminal has always read as the interrupt — is spelled out
 * in `src/main/appMenu.ts`, next to what it would cost to change.
 */
export function paneKeyHandler(keys: PaneKeys): (event: KeyboardEvent) => boolean {
  const clipboard = keys.clipboard ?? { copy: copyText, read: pasteText }
  return (event) => {
    if (keys.isAppChord(event)) return false
    const intent = paneKeyIntent(event, keys.modifier, keys.term.hasSelection())
    if (intent === 'emulator') return true
    // One press raises a keydown, a keypress and a keyup, and all three land
    // here. Acting on the keydown alone is what makes one press one copy; the
    // other two are still kept from the emulator, because half a chord typed
    // into a program is worse than none of it.
    if (event.type !== 'keydown') return false
    if (intent === 'copy') clipboard.copy(keys.term.getSelection())
    else if (intent === 'interrupt') keys.send(INTERRUPT)
    else {
      void clipboard.read().then((text) => {
        if (text === '') return
        try {
          // Through the emulator rather than straight to the pty: `paste` is
          // what puts the bracketed-paste markers around the text when the
          // program asked for them, and what stops a pasted newline running a
          // command nobody has finished reading.
          keys.byHand?.()
          keys.term.paste(text)
        } catch {
          // Reading the clipboard is the one thing here that takes a turn of
          // the loop, which is long enough for the pane to have been closed
          // underneath it. Nothing to paste into and nothing to say.
        }
      })
    }
    return false
  }
}

/**
 * Who a keypress in a pane belongs to, once the app's own chords have had it.
 *
 * - `copy` — there is a selection, and the chord means take it.
 * - `interrupt` — the same chord with nothing selected, which in a terminal
 *   means the other thing it has always meant.
 * - `paste` — put the clipboard in, through the emulator so the program gets
 *   the brackets it asked for.
 * - `emulator` — everything else, which is nearly everything.
 *
 * **The copy/interrupt fork is the whole reason this is a function.** The copy
 * chord in a pane is genuinely two commands wearing one chord, and which one it
 * is cannot be decided by the key: it is decided by whether anything is
 * selected, which is the emulator's state and not the keyboard's. Getting it
 * the wrong way round loses work in both directions — a copy that kills the
 * agent that just printed the thing you were copying, or an interrupt that
 * quietly does nothing while a runaway process keeps going.
 *
 * Nothing is copied by selecting. Copy-on-selection is what makes a stray
 * double-click overwrite the clipboard you were about to paste from, and the
 * chord costs one keypress.
 *
 * **Only where the app modifier is the command key**, which is to say macOS.
 * Everywhere else the platform modifier *is* the control key, Ctrl+C is the
 * interrupt itself, and a rule that turned it into a copy whenever an old
 * selection happened to be lying around would be taking the one keystroke a
 * terminal must never lose.
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
