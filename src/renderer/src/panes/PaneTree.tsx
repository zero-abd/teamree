// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed.

import type { PaneNode, Terminal } from '@shared/entities'
import { freshAgentLabel } from '@shared/paneRestore'
import { paneNames } from '../sidebar/agentRows'
import { TerminalView } from '../terminal/TerminalView'
import { collectTerminalIds } from './paneLayout'
import { SplitFrame } from './SplitFrame'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  /**
   * What each pane is called, by id — the same names the tab strip draws, so
   * the bar under a tab never says something other than the tab. Worked out
   * once at the root of the tree and handed down; a caller leaves it out.
   */
  names?: Readonly<Record<string, string>>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
  /** Runs an exited pane's program again, in the same pane. */
  onRelaunch: (terminalId: string) => void
  onResize: (path: number[], sizes: number[]) => void
  isAppChord: (event: KeyboardEvent) => boolean
  closeHint: string
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
  if (node.kind === 'leaf') {
    return <PaneLeaf terminalId={node.terminalId} {...callbacks} names={names} />
  }
  return <PaneSplit node={node} path={path} {...callbacks} names={names} />
}

/**
 * The tree's panes named together, the way `paneTabs` names them: a person's
 * own label, else the agent, else the program — and twins nobody named told
 * apart by number. A leaf whose record has not arrived is called what the bar
 * paints meanwhile.
 */
function namesById(root: PaneNode, terminals: Readonly<Record<string, Terminal>>): Record<string, string> {
  const ids = collectTerminalIds(root)
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
  closeHint,
  searchTerminalId,
  searchToken,
  onCloseSearch
}: PaneCallbacks & { terminalId: string }): React.JSX.Element {
  const terminal = terminals[terminalId]
  const focused = focusedTerminalId === terminalId
  // A shell that died has to look dead: the pane keeps its scrollback, so
  // without this it is indistinguishable from one waiting at a prompt.
  const exited = terminal !== undefined && !terminal.running
  // One name per pane. The strip, this bar, the close button and the question
  // asked before closing all read it from the same rule.
  const name = names?.[terminalId] ?? terminal?.title ?? 'terminal'

  return (
    <section className={`pane${focused ? ' pane--focused' : ''}${exited ? ' pane--exited' : ''}`} aria-label={name}>
      <header className="pane__bar">
        <span className={`pane__dot${exited ? ' pane__dot--stopped' : ''}`} aria-hidden="true" />
        <span className="pane__title">{name}</span>
        {exited ? (
          <span className="pane__exit">exited{terminal?.exitCode === undefined ? '' : ` ${terminal.exitCode}`}</span>
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
          <span className={`pane__restored pane__restored--${terminal.restored}`} title={restoredTitle(terminal)}>
            {restoredBadge(terminal)}
          </span>
        )}
        <span className="pane__meta">{terminal ? `${terminal.cols}×${terminal.rows}` : ''}</span>
        <button
          type="button"
          className="pane__close"
          title={`Close pane · ${closeHint}`}
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

/**
 * The badge, in the words the banner in the scrollback uses. `restarted` is
 * an agent started over — "fresh claude", as the line under the record says —
 * and not a shell, whatever else is true of it.
 */
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
      return 'This pane came back from the last run with its session resumed.'
    case 'restarted':
      return `This pane came back from the last run. No conversation to resume; a ${freshAgentLabel(
        terminal.agent ?? 'agent'
      )} is running.`
    default:
      return 'This pane came back from the last run. The shell is new; whatever it was running is gone.'
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
