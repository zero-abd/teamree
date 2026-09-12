// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed.

import { Fragment, useCallback, useRef, useState } from 'react'
import type { PaneNode, Terminal } from '@shared/entities'
import { TerminalView } from '../terminal/TerminalView'
import { applyGutterDrag, GUTTER_PX, splitChildBases } from './paneLayout'
import { usePointerDrag } from './usePointerDrag'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
  onResize: (path: number[], sizes: number[]) => void
  isAppChord: (event: KeyboardEvent) => boolean
  closeHint: string
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
  closeHint
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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startDrag = usePointerDrag()
  // Sizes are tracked locally while a handle is held so the drag stays at
  // frame rate and only the released position is persisted.
  const [draft, setDraft] = useState<number[] | null>(null)
  const sizes = draft ?? node.sizes
  const bases = splitChildBases(sizes)

  const axisLength = useCallback((): number => {
    const element = containerRef.current
    if (!element) return 0
    const gutters = (node.children.length - 1) * GUTTER_PX
    return (node.direction === 'row' ? element.clientWidth : element.clientHeight) - gutters
  }, [node.children.length, node.direction])

  const beginDrag = (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    const total = axisLength()
    if (total <= 0) return
    const start = node.direction === 'row' ? event.clientX : event.clientY
    const origin = [...sizes]

    const move = (moveEvent: PointerEvent): void => {
      const delta = (node.direction === 'row' ? moveEvent.clientX : moveEvent.clientY) - start
      setDraft(applyGutterDrag(origin, index, delta, total))
    }
    const finish = (upEvent: PointerEvent | null): void => {
      setDraft(null)
      if (!upEvent) return
      const delta = (node.direction === 'row' ? upEvent.clientX : upEvent.clientY) - start
      onResize(path, applyGutterDrag(origin, index, delta, total))
    }
    startDrag(event, node.direction === 'row' ? 'col-resize' : 'row-resize', move, finish)
  }

  const nudge = (index: number) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = node.direction === 'row' ? 'ArrowRight' : 'ArrowDown'
    const back = node.direction === 'row' ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== forward && event.key !== back) return
    const total = axisLength()
    if (total <= 0) return
    event.preventDefault()
    onResize(path, applyGutterDrag(sizes, index, event.key === forward ? 24 : -24, total))
  }

  return (
    <div className={`split split--${node.direction}`} ref={containerRef}>
      {node.children.map((child, index) => (
        <Fragment key={paneKey(child, index)}>
          <div className="split__cell" style={{ flexBasis: bases[index] }}>
            <PaneTree node={child} path={[...path, index]} onResize={onResize} {...callbacks} />
          </div>
          {index < node.children.length - 1 ? (
            <div
              className={`gutter gutter--${node.direction}`}
              role="separator"
              tabIndex={0}
              aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
              aria-label={`Resize panes ${index + 1} and ${index + 2}`}
              aria-valuenow={Math.round((sizes[index] ?? 0) * 100)}
              onPointerDown={beginDrag(index)}
              onKeyDown={nudge(index)}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
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
