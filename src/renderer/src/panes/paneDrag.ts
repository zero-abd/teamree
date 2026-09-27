// Dragging a tab: along its strip to reorder, onto another group's strip to move it there, or onto a pane
// to split it out at that edge or join that group's tabs. The drag lives here; `PaneDragLayer` draws where it lands.

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { PaneNode } from '@shared/entities'
import { leavesRoom } from '@shared/paneRoom'
import { useWorkspaceStore } from '../state/workspaceStore'
import { paneGrid } from '../terminal/paneMetrics'
import { dropTab, moveTab } from './paneGroups'
import type { DropEdge } from './paneLayout'

export type Rect = { x: number; y: number; width: number; height: number }

/** The tab being dragged. */
export type DragSource = { id: string; label: string }

/** `group` names any tab of the group; `index` is where the tab ends up, not the gap it was dropped in. */
export type DropTarget = { kind: 'tabs'; group: string; index: number } | { kind: 'pane'; id: string; edge: DropEdge }

/** `refused`: letting go here would leave a pane under its floor, so it will be refused. */
export type Drop = { target: DropTarget; mark: Rect; line: boolean; refused: boolean }

type PaneDrag = { source: DragSource; x: number; y: number; drop: Drop | null }

export const usePaneDrag = create<{ drag: PaneDrag | null }>(() => ({ drag: null }))

/** How far a pointer travels before a press on a tab becomes a drag rather than a click. */
const DRAG_SLOP_PX = 5

const LINE_PX = 2

/** The side of `rect` the point is in: the outer third nearest it, else the centre. */
export function dropEdge(rect: Rect, x: number, y: number): DropEdge {
  const fx = (x - rect.x) / rect.width
  const fy = (y - rect.y) / rect.height
  const dx = Math.min(fx, 1 - fx)
  const dy = Math.min(fy, 1 - fy)
  if (dx >= 1 / 3 && dy >= 1 / 3) return 'center'
  if (dx <= dy) return fx < 0.5 ? 'left' : 'right'
  return fy < 0.5 ? 'top' : 'bottom'
}

/** The part of `rect` a pane dropped on `edge` would take. */
export function edgeArea(rect: Rect, edge: DropEdge): Rect {
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  switch (edge) {
    case 'left':
      return { ...rect, width: halfWidth }
    case 'right':
      return { ...rect, x: rect.x + halfWidth, width: halfWidth }
    case 'top':
      return { ...rect, height: halfHeight }
    case 'bottom':
      return { ...rect, y: rect.y + halfHeight, height: halfHeight }
    default:
      return rect
  }
}

/** The gap among `tabs` nearest `x`: how many of them have their middle left of it. */
export function gapAt(tabs: readonly Rect[], x: number): number {
  return tabs.filter((tab) => tab.x + tab.width / 2 < x).length
}

/** The tree once `source` is let go on `target`; the same tree when that changes nothing. */
export function arranged(root: PaneNode, source: DragSource, target: DropTarget): PaneNode {
  return target.kind === 'tabs'
    ? moveTab(root, source.id, target.group, target.index)
    : dropTab(root, source.id, target.id, target.edge)
}

/** Press handler for a draggable tab; a press that never travels stays a click. */
export function useTabDrag(): (event: React.PointerEvent<HTMLElement>, source: DragSource) => void {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  return (event, source) => {
    if (event.button !== 0 || (event.target as Element).closest('.tab__close, .tab__rename, input')) {
      return
    }
    cleanup.current?.()
    const element = event.currentTarget
    const pointerId = event.pointerId
    const start = { x: event.clientX, y: event.clientY }
    let dragging = false

    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_SLOP_PX) return
        dragging = true
        element.setPointerCapture(pointerId)
        document.body.classList.add('is-dragging-pane')
      }
      usePaneDrag.setState({
        drag: { source, x: next.clientX, y: next.clientY, drop: dropAt(source, next.clientX, next.clientY) }
      })
    }
    const dispose = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      cleanup.current = null
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      document.body.classList.remove('is-dragging-pane')
      usePaneDrag.setState({ drag: null })
    }
    const finish = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      const drop = usePaneDrag.getState().drag?.drop ?? null
      dispose()
      if (!dragging) return
      // The click a drag ends with is not a click on the tab.
      const swallow = (click: MouseEvent): void => click.stopPropagation()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      if (drop !== null) {
        useWorkspaceStore.getState().arrangePanes((root) => arranged(root, source, drop.target), source.id)
      }
    }
    const cancel = (): void => dispose()
    const escape = (key: KeyboardEvent): void => {
      if (key.key !== 'Escape' || !dragging) return
      key.preventDefault()
      key.stopPropagation()
      dispose()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    cleanup.current = dispose
  }
}

/** What letting go at (x, y) would do, read off the elements under the pointer; null for nothing. */
function dropAt(source: DragSource, x: number, y: number): Drop | null {
  const state = useWorkspaceStore.getState()
  const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  const root = layout?.root
  if (!root) return null
  const under = document.elementFromPoint(x, y)
  const grid = paneGrid(state.terminalFontSize, state.terminalOptions)
  const drop = (target: DropTarget, mark: Rect, line: boolean): Drop | null => {
    const next = arranged(root, source, target)
    if (next === root) return null
    return { target, mark, line, refused: grid !== undefined && !leavesRoom(root, next, grid.area, grid.minPane) }
  }

  const group = under?.closest<HTMLElement>('.group')
  const member = group?.dataset.group
  if (!group || member === undefined) return null
  const list = under?.closest<HTMLElement>('.tabs')
  if (list) {
    const tabs = [...list.querySelectorAll<HTMLElement>('.tab[data-pane-id]')]
    const boxes = tabs.map((tab) => rectOf(tab))
    const gap = gapAt(boxes, x)
    const from = tabs.findIndex((tab) => tab.dataset.paneId === source.id)
    const index = from !== -1 && gap > from ? gap - 1 : gap
    const bounds = rectOf(list)
    const last = boxes[gap - 1]
    const edge = gap === 0 ? (boxes[0]?.x ?? bounds.x) : (last?.x ?? 0) + (last?.width ?? 0)
    const mark = { x: edge - LINE_PX / 2, y: bounds.y, width: LINE_PX, height: bounds.height }
    return drop({ kind: 'tabs', group: member, index }, mark, true)
  }

  const body = group.querySelector<HTMLElement>(':scope > .group__body')
  if (!body) return null
  const pane = rectOf(body)
  const target: DropTarget = { kind: 'pane', id: member, edge: dropEdge(pane, x, y) }
  return drop(target, edgeArea(pane, target.edge), false)
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}
