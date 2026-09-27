// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { PaneNode, Terminal } from '@shared/entities'
import {
  fileTabName,
  isFileColumn,
  isFileLeaf,
  shownTabId,
  type FileColumn,
  type FileLeaf as FileLeafNode
} from '@shared/filePane'
import { freshAgentLabel } from '@shared/paneRestore'
import { minExtent, type Box } from '@shared/paneRoom'
import { runState } from '@shared/runCommands'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { paneNamesById } from '../sidebar/agentRows'
import { RowMenu, type RowMenuAnchor } from '../sidebar/RowMenu'
import type { WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { TerminalView } from '../terminal/TerminalView'
import { useWorkspaceStore } from '../state/workspaceStore'
import { usePaneMenu } from '../workspace/paneMenu'
import { RESUME_CONVERSATION } from '../workspace/startMenu'
import { UnsavedDot } from '../files/FileBar'
import { FilePane } from './FilePane'
import { usePaneDrag, useTabDrag } from './paneDrag'
import { normalizeSizes } from './paneLayout'
import { SplitFrame } from './SplitFrame'
import { Icon } from '../icons/Icon'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  /** The worktree a file pane's file is read from. */
  worktreeId: string
  /** What names that worktree; its agent pane goes by its title, as on the tab. */
  worktree?: WorktreeNameSource
  /** Each pane's name by id, the tab strip's names, worked out once at the root; callers leave it out. */
  names?: Readonly<Record<string, string>>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
  /** Runs an exited pane's program again, in the same pane. */
  onRelaunch: (terminalId: string) => void
  /** Picks a conversation for an ended agent pane to resume in place; absent leaves the button out. */
  onResumeConversation?: (terminalId: string) => void
  onResize: (path: number[], sizes: number[]) => void
  isAppChord: (event: KeyboardEvent) => boolean
  /** Spells the chords in the header's right-click menu. */
  modifier: PlatformModifier
  /** The one pane showing the find bar, if any. */
  searchTerminalId: string | null
  searchToken: number
  onCloseSearch: () => void
  /** The least a pane may be dragged to, chrome included; unmeasured, a small fraction stands. */
  minPane?: Box
  /** The file column is folded to its tab in the strip: drawn nowhere, its share lent to its siblings. */
  foldedColumn?: boolean
}

export function PaneTree({
  node,
  path,
  ...callbacks
}: PaneCallbacks & { node: PaneNode; path: number[] }): React.JSX.Element {
  const names = callbacks.names ?? namesById(callbacks.worktreeId, callbacks.terminals, callbacks.worktree)
  if (isFileLeaf(node)) {
    return <FileLeaf leaf={node} {...callbacks} />
  }
  if (node.kind === 'leaf') {
    return <PaneLeaf terminalId={node.terminalId} {...callbacks} names={names} />
  }
  if (isFileColumn(node)) return <FileColumnPane node={node} {...callbacks} />
  return <PaneSplit node={node} path={path} {...callbacks} names={names} />
}

function FileLeaf({
  leaf,
  tabbed = false,
  worktreeId,
  focusedTerminalId,
  onFocus,
  onClose,
  searchTerminalId,
  searchToken,
  onCloseSearch,
  modifier
}: PaneCallbacks & { leaf: FileLeafNode; tabbed?: boolean }): React.JSX.Element {
  const menu = usePaneMenu(modifier)
  const paneId = leaf.terminalId
  const name = fileTabName(leaf)
  return (
    <>
      <FilePane
        paneId={paneId}
        worktreeId={worktreeId}
        path={leaf.path}
        {...(leaf.commit === undefined ? {} : { commit: leaf.commit })}
        {...(leaf.compare === undefined ? {} : { compare: leaf.compare })}
        {...(leaf.review === true ? { review: true } : {})}
        {...(leaf.sharedNote === undefined ? {} : { sharedNote: leaf.sharedNote })}
        focused={focusedTerminalId === paneId}
        onFocus={() => onFocus(paneId)}
        onClose={() => onClose(paneId)}
        tabbed={tabbed}
        onHeaderMenu={(event) => menu.onContextMenu(paneId, name, event)}
        onMenu={(event) => menu.onButton(paneId, name, event)}
        searchToken={searchTerminalId === paneId ? searchToken : 0}
        onCloseSearch={onCloseSearch}
      />
      {menu.menu}
    </>
  )
}

/** The file column: a tab per file, and every file's pane kept mounted under them, the shown one drawn. */
function FileColumnPane({ node, ...callbacks }: PaneCallbacks & { node: FileColumn }): React.JSX.Element {
  const unsaved = useWorkspaceStore((state) => state.unsavedFiles)
  const pin = useWorkspaceStore((state) => state.pinFilePane)
  const startDrag = useTabDrag()
  const dragged = usePaneDrag((state) => state.drag?.source.id)
  const shown = shownTabId(node)
  const tabs = node.children.filter(isFileLeaf)
  const focused = tabs.some((tab) => tab.terminalId === callbacks.focusedTerminalId)
  const strip = useRef<HTMLDivElement | null>(null)
  const [outside, setOutside] = useState(0)
  const [listing, setListing] = useState<{ anchor: RowMenuAnchor; opener: HTMLElement } | null>(null)
  const count = useCallback(() => setOutside(cutTabsOutOfView(strip.current)), [])
  const shownTab = useCallback(
    () =>
      shown === undefined
        ? null
        : (strip.current?.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(shown)}"]`) ?? null),
    [shown]
  )

  // However a tab comes to be shown (a click, ⌃PageDown, ⌘P, a link), it is scrolled into sight, and kept
  // there as the strip or the tab changes width (an unsaved dot, a narrower window).
  useLayoutEffect(() => {
    const reveal = (): void => {
      const element = strip.current
      const tab = shownTab()
      if (element && tab) bringIntoView(element, tab)
      count()
    }
    reveal()
    const element = strip.current
    const tab = shownTab()
    if (element === null) return
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    if (tab !== null) observer.observe(tab)
    return () => observer.disconnect()
  }, [shownTab, tabs.length, count])

  const names = tabs.map(fileTabName)
  const closeListing = (): void => {
    listing?.opener.focus()
    setListing(null)
  }
  return (
    <div className={`column${focused ? ' column--focused' : ''}`}>
      {/* One file is named, dotted and closed by its tab in the window's strip. */}
      <div className="column__bar" hidden={tabs.length < 2}>
        <div className="column__tabs" role="tablist" aria-label="Open files" ref={strip} onScroll={count}>
          {tabs.map((tab) => {
            const name = fileTabName(tab)
            const on = tab.terminalId === shown
            const preview = node.preview === tab.terminalId
            return (
              <div
                key={tab.terminalId}
                className={`column__tab${on ? ' column__tab--shown' : ''}${
                  dragged === tab.terminalId ? ' column__tab--dragged' : ''
                }`}
                data-pane-id={tab.terminalId}
                onPointerDown={(event) => startDrag(event, { kind: 'tab', id: tab.terminalId, label: name })}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`column__name${preview ? ' column__name--preview' : ''}`}
                  title={tab.path}
                  onClick={() => callbacks.onFocus(tab.terminalId)}
                  onDoubleClick={() => pin(tab.terminalId)}
                >
                  {name}
                </button>
                {unsaved[tab.terminalId] ? <UnsavedDot /> : null}
                <button
                  type="button"
                  className="column__close"
                  title="Close"
                  aria-label={`Close ${name}`}
                  onClick={() => callbacks.onClose(tab.terminalId)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )
          })}
        </div>
        {outside === 0 ? null : (
          <button
            type="button"
            className="column__more"
            aria-label="All open files"
            aria-haspopup="menu"
            aria-expanded={listing !== null}
            onClick={(event) => {
              if (listing !== null) return closeListing()
              const box = event.currentTarget.getBoundingClientRect()
              setListing({ anchor: { x: box.right, y: box.bottom + 4, align: 'right' }, opener: event.currentTarget })
            }}
          >
            +{outside}
          </button>
        )}
      </div>
      {listing === null ? null : (
        <RowMenu
          label="Open files"
          anchor={listing.anchor}
          opener={listing.opener}
          onClose={closeListing}
          items={tabs.map((tab, at) => {
            const name = names[at] ?? tab.path
            return {
              // A second file of the same name goes by its path, so every row reads apart.
              label: names.indexOf(name) === names.lastIndexOf(name) ? name : tab.path,
              icon: <span className="column__mark">{unsaved[tab.terminalId] ? <UnsavedDot /> : null}</span>,
              current: tab.terminalId === shown,
              onChoose: () => callbacks.onFocus(tab.terminalId)
            }
          })}
        />
      )}
      {tabs.map((tab) => (
        <div key={tab.terminalId} className="column__page" hidden={tab.terminalId !== shown}>
          <FileLeaf leaf={tab} tabbed {...callbacks} />
        </div>
      ))}
    </div>
  )
}

/** Scrolls the strip the least that shows all of `tab`, to a tab's left edge so the strip starts on a whole one. */
function bringIntoView(strip: HTMLElement, tab: HTMLElement): void {
  const end = tab.offsetLeft + tab.offsetWidth
  if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft
  else if (end > strip.scrollLeft + strip.clientWidth) {
    const least = end - strip.clientWidth
    const edge = [...strip.querySelectorAll<HTMLElement>('.column__tab')].find((each) => each.offsetLeft >= least)
    strip.scrollLeft = Math.min(edge?.offsetLeft ?? least, tab.offsetLeft)
  }
}

/** Marks `data-cut` on every tab not wholly in sight, so no half name shows, and counts them. */
function cutTabsOutOfView(strip: HTMLElement | null): number {
  if (strip === null) return 0
  const fits = strip.scrollWidth <= strip.clientWidth
  const from = strip.scrollLeft
  const to = from + strip.clientWidth
  let cut = 0
  for (const tab of strip.querySelectorAll<HTMLElement>('.column__tab')) {
    const outside = !fits && (tab.offsetLeft < from || tab.offsetLeft + tab.offsetWidth > to)
    tab.toggleAttribute('data-cut', outside)
    if (outside) cut += 1
  }
  return cut
}

/** The worktree's panes named in the order they were opened, as `paneTabs` and the sidebar name them. */
function namesById(
  worktreeId: string,
  terminals: Readonly<Record<string, Terminal>>,
  worktree: WorktreeNameSource | undefined
): Record<string, string> {
  return paneNamesById(
    Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId),
    worktree
  )
}

function PaneLeaf({
  terminalId,
  terminals,
  names,
  focusedTerminalId,
  onFocus,
  onRelaunch,
  onResumeConversation,
  isAppChord,
  searchTerminalId,
  searchToken,
  onCloseSearch,
  modifier
}: PaneCallbacks & { terminalId: string }): React.JSX.Element {
  const menu = usePaneMenu(modifier)
  const terminal = terminals[terminalId]
  const focused = focusedTerminalId === terminalId
  // A dead shell keeps its scrollback, so without this it looks like one at a prompt.
  const exited = terminal !== undefined && !terminal.running
  // Never started this launch: the badge says so, and its exit code means nothing.
  const stopped = terminal?.restored === 'stopped'
  // A run ended by Stop or the quit's hang-up: its signal code is not a result.
  const runStopped = exited && terminal.run !== undefined && runState(terminal) === 'stopped'
  // One name per pane, shared by strip, region, menu and close question.
  const name = names?.[terminalId] ?? terminal?.title ?? 'terminal'

  const status = (
    <>
      {exited && !stopped ? (
        runStopped ? (
          <span className="chip pane__exit" title={`exited ${terminal.exitCode}`}>
            stopped
          </span>
        ) : (
          <span className="chip pane__exit">
            exited{terminal?.exitCode === undefined ? '' : ` ${terminal.exitCode}`}
          </span>
        )
      ) : null}
      {/* Beside the badge that says the pane is dead, because the next thing anybody does about a
          dead pane is this; the pane menu's word for an agent or a Run pane, since that is not a new shell. */}
      {exited && stopped && onResumeConversation !== undefined ? (
        <button type="button" className="pane__again" onClick={() => onResumeConversation(terminalId)}>
          {RESUME_CONVERSATION}
        </button>
      ) : null}
      {exited ? (
        <button type="button" className="pane__again" onClick={() => onRelaunch(terminalId)}>
          {stopped
            ? 'Start Fresh'
            : terminal?.agent === undefined && terminal?.run === undefined
              ? 'New Shell'
              : 'Run Again'}
        </button>
      ) : null}
      {terminal?.restored === undefined ? null : (
        <span className={`chip pane__restored pane__restored--${terminal.restored}`} title={restoredTitle(terminal)}>
          {restoredBadge(terminal)}
        </span>
      )}
    </>
  )

  return (
    <section className={`pane pane--terminal${focused ? ' pane--focused' : ''}`} aria-label={name}>
      {/* The tab is its name, dot and close; what is left to say is how it ended or came back. */}
      {exited || terminal?.restored !== undefined ? (
        <div className="pane__notice" onContextMenu={(event) => menu.onContextMenu(terminalId, name, event)}>
          {status}
        </div>
      ) : null}
      <TerminalView
        terminalId={terminalId}
        focused={focused}
        onFocus={() => onFocus(terminalId)}
        isAppChord={isAppChord}
        searchOpen={searchTerminalId === terminalId}
        searchToken={searchToken}
        onCloseSearch={onCloseSearch}
      />
      {menu.menu}
    </section>
  )
}

/** The badge, in the scrollback banner's words; `restarted` is an agent started fresh, not a shell. */
function restoredBadge(terminal: Terminal): string {
  switch (terminal.restored) {
    case 'agent':
      return 'resumed'
    case 'restarted':
      return freshAgentLabel(terminal.agent ?? 'agent')
    case 'stopped':
      return 'stopped'
    default:
      return 'new shell'
  }
}

function restoredTitle(terminal: Terminal): string {
  switch (terminal.restored) {
    case 'agent':
      return 'Restored · session resumed'
    case 'restarted':
      return `Restored · nothing to resume, ${freshAgentLabel(terminal.agent ?? 'agent')} running`
    case 'stopped':
      return 'Restored · agent not started, task not re-sent'
    default:
      return 'Restored · new shell, previous process gone'
  }
}

function PaneSplit({
  node,
  path,
  onResize,
  ...callbacks
}: PaneCallbacks & { node: Extract<PaneNode, { kind: 'split' }>; path: number[] }): React.JSX.Element {
  const { minPane, foldedColumn = false } = callbacks
  // Indices into the whole split, so a resize addresses the tree the runtime holds.
  const drawn = node.children.flatMap((child, index) => (foldedColumn && isFileColumn(child) ? [] : [{ child, index }]))
  const sizes = normalizeSizes(node.sizes, node.children.length)
  const lent = 1 - drawn.reduce((sum, { index }) => sum + (sizes[index] ?? 0), 0)
  return (
    <SplitFrame
      direction={node.direction}
      sizes={drawn.map(({ index }) => sizes[index] ?? 0)}
      onResize={(next) => {
        const whole = [...sizes]
        drawn.forEach(({ index }, at) => (whole[index] = (next[at] ?? 0) * (1 - lent)))
        onResize(path, whole)
      }}
      minPx={minPane && drawn.map(({ child }) => minExtent(child, node.direction, minPane))}
      cells={drawn.map(({ child, index }) => ({
        key: paneKey(child, index),
        node: <PaneTree node={child} path={[...path, index]} onResize={onResize} {...callbacks} />
      }))}
    />
  )
}

/** Keys follow the terminals, so resizing never remounts (and reloads) a pane. */
function paneKey(node: PaneNode, index: number): string {
  if (node.kind === 'leaf') return node.terminalId
  // One column per tree; keyed by a tab, a closed first tab would remount every editor in it.
  return isFileColumn(node) ? 'file-column' : `split:${index}:${firstTerminalId(node)}`
}

function firstTerminalId(node: PaneNode): string {
  if (node.kind === 'leaf') return node.terminalId
  const first = node.children[0]
  return first ? firstTerminalId(first) : 'empty'
}
