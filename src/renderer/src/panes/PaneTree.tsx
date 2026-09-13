// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed.

import type { PaneNode, Terminal } from '@shared/entities'
import { TerminalView } from '../terminal/TerminalView'
import { SplitFrame } from './SplitFrame'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
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
  if (node.kind === 'leaf') {
    return <PaneLeaf terminalId={node.terminalId} {...callbacks} />
  }
  return <PaneSplit node={node} path={path} {...callbacks} />
}

function PaneLeaf({
  terminalId,
  terminals,
  focusedTerminalId,
  onFocus,
  onClose,
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

  return (
    <section
      className={`pane${focused ? ' pane--focused' : ''}${exited ? ' pane--exited' : ''}`}
      aria-label={terminal?.title ?? 'terminal'}
    >
      <header className="pane__bar">
        <span className={`pane__dot${exited ? ' pane__dot--stopped' : ''}`} aria-hidden="true" />
        <span className="pane__title">{terminal?.title ?? 'terminal'}</span>
        {exited ? (
          <span className="pane__exit">exited{terminal?.exitCode === undefined ? '' : ` ${terminal.exitCode}`}</span>
        ) : null}
        {terminal?.restored === undefined ? null : (
          <span
            className={`pane__restored pane__restored--${terminal.restored}`}
            title={
              terminal.restored === 'agent'
                ? 'This pane came back from the last run with its session resumed.'
                : 'This pane came back from the last run. The shell is new; whatever it was running is gone.'
            }
          >
            {terminal.restored === 'agent' ? 'resumed' : 'new shell'}
          </span>
        )}
        <span className="pane__meta">{terminal ? `${terminal.cols}×${terminal.rows}` : ''}</span>
        <button
          type="button"
          className="pane__close"
          title={`Close pane · ${closeHint}`}
          aria-label={`Close pane ${terminal?.title ?? ''}`}
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
