// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed.

import type { PaneNode, Terminal } from '@shared/entities'
import { isFileLeaf } from '@shared/filePane'
import { freshAgentLabel } from '@shared/paneRestore'
import { ACTIVITY_LABEL, activityOf, paneNames } from '../sidebar/agentRows'
import { TerminalView } from '../terminal/TerminalView'
import { FilePane } from './FilePane'
import { collectLeaves } from './paneLayout'
import { SplitFrame } from './SplitFrame'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  /** The worktree a file pane's file is read from. */
  worktreeId: string
  /** Each pane's name by id, the tab strip's names, worked out once at the root; callers leave it out. */
  names?: Readonly<Record<string, string>>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
  /** Runs an exited pane's program again, in the same pane. */
  onRelaunch: (terminalId: string) => void
  onResize: (path: number[], sizes: number[]) => void
  isAppChord: (event: KeyboardEvent) => boolean
  /** The one pane showing the find bar, if any. */
  searchTerminalId: string | null
  searchToken: number
  onCloseSearch: () => void
}

export function PaneTree({
  node,
  path,
  ...callbacks
}: PaneCallbacks & { node: PaneNode; path: number[] }): React.JSX.Element {
  const names = callbacks.names ?? namesById(node, callbacks.terminals)
  if (isFileLeaf(node)) {
    return (
      <FilePane
        paneId={node.terminalId}
        worktreeId={callbacks.worktreeId}
        path={node.path}
        focused={callbacks.focusedTerminalId === node.terminalId}
        onFocus={() => callbacks.onFocus(node.terminalId)}
        onClose={() => callbacks.onClose(node.terminalId)}
        searchToken={callbacks.searchTerminalId === node.terminalId ? callbacks.searchToken : 0}
      />
    )
  }
  if (node.kind === 'leaf') {
    return <PaneLeaf terminalId={node.terminalId} {...callbacks} names={names} />
  }
  return <PaneSplit node={node} path={path} {...callbacks} names={names} />
}

/** The tree's panes named together as `paneTabs` names them: label, agent, program, twins numbered. */
function namesById(root: PaneNode, terminals: Readonly<Record<string, Terminal>>): Record<string, string> {
  // Terminals only: a file pane is named after its file.
  const ids = collectLeaves(root)
    .filter((leaf) => !isFileLeaf(leaf))
    .map((leaf) => leaf.terminalId)
  const names = paneNames(ids.map((id) => terminals[id] ?? { title: 'terminal', shell: '' }))
  return Object.fromEntries(ids.map((id, index) => [id, names[index] ?? 'terminal']))
}

function PaneLeaf({
  terminalId,
  terminals,
  names,
  focusedTerminalId,
  onFocus,
  onClose,
  onRelaunch,
  isAppChord,
  searchTerminalId,
  searchToken,
  onCloseSearch
}: PaneCallbacks & { terminalId: string }): React.JSX.Element {
  const terminal = terminals[terminalId]
  const focused = focusedTerminalId === terminalId
  // A dead shell keeps its scrollback, so without this it looks like one at a prompt.
  const exited = terminal !== undefined && !terminal.running
  // One name per pane, shared by strip, bar, close button and close question.
  const name = names?.[terminalId] ?? terminal?.title ?? 'terminal'
  // The same reading the sidebar row, the tab and the board give this pane.
  const activity = terminal === undefined ? null : activityOf(terminal)
  // The grid size is on the name's hover: nobody acts on it.
  const hover = terminal === undefined ? name : `${name} · ${terminal.cols}×${terminal.rows}`

  return (
    <section className={`pane${focused ? ' pane--focused' : ''}${exited ? ' pane--exited' : ''}`} aria-label={name}>
      <header className="pane__bar">
        <span
          className={activity === null ? 'activity' : `activity activity--${activity}`}
          title={activity === null ? undefined : ACTIVITY_LABEL[activity]}
          aria-hidden="true"
        />
        <span className="pane__title" title={hover}>
          {name}
        </span>
        {exited ? (
          <span className="chip pane__exit">
            exited{terminal?.exitCode === undefined ? '' : ` ${terminal.exitCode}`}
          </span>
        ) : null}
        {/* Beside the badge that says the pane is dead, because the next thing
            anybody does about a dead pane is this. An agent is named, since
            running one again is a different act from opening a shell. */}
        {exited ? (
          <button type="button" className="pane__again" onClick={() => onRelaunch(terminalId)}>
            {terminal?.agent === undefined ? 'New shell' : `Run ${terminal.agent} again`}
          </button>
        ) : null}
        {terminal?.restored === undefined ? null : (
          <span className={`chip pane__restored pane__restored--${terminal.restored}`} title={restoredTitle(terminal)}>
            {restoredBadge(terminal)}
          </span>
        )}
        <button
          type="button"
          className="pane__close"
          title="Close pane"
          aria-label={`Close pane ${name}`}
          onClick={() => onClose(terminalId)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>
      <TerminalView
        terminalId={terminalId}
        focused={focused}
        onFocus={() => onFocus(terminalId)}
        isAppChord={isAppChord}
        searchOpen={searchTerminalId === terminalId}
        searchToken={searchToken}
        onCloseSearch={onCloseSearch}
      />
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
  return (
    <SplitFrame
      direction={node.direction}
      sizes={node.sizes}
      onResize={(sizes) => onResize(path, sizes)}
      cells={node.children.map((child, index) => ({
        key: paneKey(child, index),
        node: <PaneTree node={child} path={[...path, index]} onResize={onResize} {...callbacks} />
      }))}
    />
  )
}

/** Keys follow the terminals, so resizing never remounts (and reloads) a pane. */
function paneKey(node: PaneNode, index: number): string {
  return node.kind === 'leaf' ? node.terminalId : `split:${index}:${firstTerminalId(node)}`
}

function firstTerminalId(node: PaneNode): string {
  if (node.kind === 'leaf') return node.terminalId
  const first = node.children[0]
  return first ? firstTerminalId(first) : 'empty'
}
