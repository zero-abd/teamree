// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed. Each
// leaf is a group: its own strip of tabs over its shown tab, the rest kept mounted.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { PaneNode, Terminal } from '@shared/entities'
import { fileColumnIn, fileTabName, isFileColumn, isFileLeaf, type FileLeaf as FileLeafNode } from '@shared/filePane'
import { freshAgentLabel } from '@shared/paneRestore'
import { minExtent, type Box } from '@shared/paneRoom'
import { runState } from '@shared/runCommands'
import { formatChord, type PlatformModifier } from '../keyboard/platformModifier'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { paneNamesById } from '../sidebar/agentRows'
import type { WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { TerminalView } from '../terminal/TerminalView'
import { useWorkspaceStore } from '../state/workspaceStore'
import { usePaneMenu } from '../workspace/paneMenu'
import { RESUME_CONVERSATION } from '../workspace/startMenu'
import { GroupStrip, type GroupEdges } from '../workspace/TerminalTabs'
import { FilePane } from './FilePane'
import { groupTabs, shownOf, type PaneGroup } from './paneGroups'
import { normalizeSizes } from './paneLayout'
import { SplitFrame } from './SplitFrame'

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
  /** Runs an exited pane's program again, in the same pane; an agent resumes unless `fresh`. */
  onRelaunch: (terminalId: string, options?: { fresh?: boolean }) => void
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
  /** The file column folded for room: drawn nowhere, its share lent to its siblings. */
  foldedColumn?: PaneNode | null
  /** Which window edges this subtree touches; the whole tree touches all. */
  edges?: GroupEdges
}

export function PaneTree({
  node,
  path,
  ...callbacks
}: PaneCallbacks & { node: PaneNode; path: number[] }): React.JSX.Element {
  const names = callbacks.names ?? namesById(callbacks.worktreeId, callbacks.terminals, callbacks.worktree)
  const tree =
    node.kind === 'leaf' || isFileColumn(node) ? (
      <PaneGroupView group={node} {...callbacks} names={names} />
    ) : (
      <PaneSplit node={node} path={path} {...callbacks} names={names} />
    )
  return path.length === 0 ? <GroupBirths>{tree}</GroupBirths> : tree
}

const ALL_EDGES: GroupEdges = { top: true, left: true, right: true }

/** The keys of the groups drawn so far in this tree, and whether its first frame is past: a group new after it fades in. */
const Births = createContext<{ seen: Set<string>; settled: { current: boolean } } | null>(null)

function GroupBirths({ children }: { children: React.ReactNode }): React.JSX.Element {
  const value = useRef({ seen: new Set<string>(), settled: { current: false } }).current
  useEffect(() => {
    value.settled.current = true
  }, [value])
  return <Births.Provider value={value}>{children}</Births.Provider>
}

/** A group: its strip over its tabs, every tab kept mounted and only the shown one drawn. */
function PaneGroupView({
  group,
  edges = ALL_EDGES,
  ...callbacks
}: PaneCallbacks & { group: PaneGroup }): React.JSX.Element {
  const tabs = groupTabs(group)
  const shown = shownOf(group)
  const births = useContext(Births)
  const key = groupKey(group)
  const born = useRef(births !== null && births.settled.current && !births.seen.has(key)).current
  births?.seen.add(key)
  const active = tabs.some((tab) => tab.terminalId === callbacks.focusedTerminalId)
  return (
    <div
      className={`group${active ? ' group--active' : ''}${born ? ' group--born' : ''}`}
      data-group={shown}
      data-tabs={tabs.length}
    >
      <GroupStrip
        group={group}
        terminals={callbacks.terminals}
        worktree={callbacks.worktree}
        edges={edges}
        active={active}
        modifier={callbacks.modifier}
        onFocus={callbacks.onFocus}
        onClose={callbacks.onClose}
      />
      <div className="group__body">
        {tabs.map((tab) => (
          <div key={tab.terminalId} className="group__page" hidden={tab.terminalId !== shown}>
            {isFileLeaf(tab) ? (
              <FileLeaf leaf={tab} {...callbacks} />
            ) : (
              <PaneLeaf terminalId={tab.terminalId} {...callbacks} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function FileLeaf({
  leaf,
  worktreeId,
  focusedTerminalId,
  onFocus,
  onClose,
  searchTerminalId,
  searchToken,
  onCloseSearch,
  modifier
}: PaneCallbacks & { leaf: FileLeafNode }): React.JSX.Element {
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
        tabbed
        onHeaderMenu={(event) => menu.onContextMenu(paneId, name, event)}
        onMenu={(event) => menu.onButton(paneId, name, event)}
        searchToken={searchTerminalId === paneId ? searchToken : 0}
        onCloseSearch={onCloseSearch}
      />
      {menu.menu}
    </>
  )
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
  onClose,
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
  // An agent that ended this launch: the end card says so and offers its conversation back.
  const endedAgent = exited && !stopped && terminal.agent !== undefined && terminal.run === undefined
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
        <button
          type="button"
          className="pane__again"
          onClick={() => (stopped ? onRelaunch(terminalId, { fresh: true }) : onRelaunch(terminalId))}
        >
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
    <section
      className={`pane pane--terminal${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onKeyDownCapture={endedAgent ? (event) => endedKeys(event, () => onRelaunch(terminalId)) : undefined}
    >
      {/* The tab is its name, dot and close; what is left to say is how it ended or came back. */}
      {!endedAgent && (exited || terminal?.restored !== undefined) ? (
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
      {endedAgent ? (
        <EndedAgent
          agent={terminal.agent!}
          exitCode={terminal.exitCode}
          modifier={modifier}
          onResume={() => onRelaunch(terminalId)}
          onNewSession={() => onRelaunch(terminalId, { fresh: true })}
          onClose={() => onClose(terminalId)}
          onContextMenu={(event) => menu.onContextMenu(terminalId, name, event)}
        />
      ) : null}
      {menu.menu}
    </section>
  )
}

/**
 * An agent that ended: what it was, and its conversation back, a new one, or the pane gone.
 * Resume is first, so Tab from the dead terminal lands on it.
 */
function EndedAgent({
  agent,
  exitCode,
  modifier,
  onResume,
  onNewSession,
  onClose,
  onContextMenu
}: {
  agent: NonNullable<Terminal['agent']>
  exitCode: number | undefined
  modifier: PlatformModifier
  onResume: () => void
  onNewSession: () => void
  onClose: () => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  const title = `${harnessName(agent)} ended`
  return (
    <div className="pane-ended" role="group" aria-label={title} onContextMenu={onContextMenu}>
      <AgentGlyph kind={agent} decorative />
      <span className="pane-ended__title">{title}</span>
      {exitCode === undefined || exitCode === 0 ? null : <span className="pane-ended__code">exit {exitCode}</span>}
      <span className="pane-ended__actions">
        <button type="button" className="button button--primary button--small" onClick={onResume}>
          Resume
          <kbd className="button__kbd" aria-hidden="true">
            {formatChord({ key: 'Enter', bare: true }, modifier)}
          </kbd>
        </button>
        <button type="button" className="button button--ghost button--small" onClick={onNewSession}>
          New Session
        </button>
        <button type="button" className="button button--ghost button--small" onClick={onClose}>
          Close
        </button>
      </span>
    </div>
  )
}

/** In an ended agent's dead terminal, Enter resumes and Tab goes to the card; the find bar and buttons keep theirs. */
function endedKeys(event: React.KeyboardEvent<HTMLElement>, resume: () => void): void {
  if ((event.target as HTMLElement).closest('.xterm') === null) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    resume()
  } else if (event.key === 'Tab' && !event.shiftKey) {
    const first = event.currentTarget.querySelector<HTMLButtonElement>('.pane-ended button')
    if (first === null) return
    event.preventDefault()
    event.stopPropagation()
    first.focus()
  }
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
  const { minPane, foldedColumn = null, edges = ALL_EDGES } = callbacks
  // Indices into the whole split, so a resize addresses the tree the runtime holds.
  const drawn = node.children.flatMap((child, index) => (child === foldedColumn ? [] : [{ child, index }]))
  const row = node.direction === 'row'
  const edgesOf = (at: number): GroupEdges => ({
    top: edges.top && (row || at === 0),
    left: edges.left && (!row || at === 0),
    right: edges.right && (!row || at === drawn.length - 1)
  })
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
      cells={drawn.map(({ child, index }, at) => ({
        key: paneKey(child, index),
        node: <PaneTree node={child} path={[...path, index]} onResize={onResize} {...callbacks} edges={edgesOf(at)} />
      }))}
    />
  )
}

/** Keys follow the terminals, so resizing never remounts (and reloads) a pane, nor a tab added to its group. */
function paneKey(node: PaneNode, index: number): string {
  return node.kind === 'leaf' || isFileColumn(node) ? groupKey(node) : `split:${index}:${firstTerminalId(node)}`
}

/** A group by its first tab; the file column by name, or closing its first tab would remount every editor in it. */
function groupKey(group: PaneGroup): string {
  if (group.kind === 'leaf') return group.terminalId
  return fileColumnIn(group) === group ? 'file-column' : firstTerminalId(group)
}

function firstTerminalId(node: PaneNode): string {
  if (node.kind === 'leaf') return node.terminalId
  const first = node.children[0]
  return first ? firstTerminalId(first) : 'empty'
}
