// How big a pane will be, in cells, before there is a pane to ask. Without a size the pty starts
// 80x24 and a full-screen agent draws its first frame at the wrong width; the refit on mount fixes
// any cell this misses.

import type { PaneNode } from '@shared/entities'
import { MIN_PANE_CELLS, PANE_CHROME, paneCellsIn, placePaneWithin } from '@shared/paneRoom'

/** The line height every pane's emulator is built with. Stated once. */
export const TERMINAL_LINE_HEIGHT = 1.25

export type PaneSize = { cols: number; rows: number }

/** A box in CSS pixels; the part of a DOMRect anything here reads. */
export type Box = { width: number; height: number }

/** A new pane's size in cells, and the grid, floor and cell it was worked out on, for the runtime to place it the same way. */
export type NewPane = PaneSize & { area: Box; minPane: Box; cell: Box }

/** Characters in the probe; a run averages away per-glyph pixel rounding. */
const PROBE_COLUMNS = 80

/** Where the pane grid is drawn; `WorkspaceArea` owns the element. */
export const PANE_GRID_SELECTOR = '.workspace__panes'

/** Stands in for the pane not yet made; no terminal or file id looks like it. */
const PROBE_ID = 'probe:new-pane'

/** A pane of `MIN_PANE_CELLS`, chrome included, in pixels. */
export function minPaneBox(cell: Box): Box {
  return {
    width: MIN_PANE_CELLS.cols * cell.width + PANE_CHROME.width,
    height: MIN_PANE_CELLS.rows * cell.height + PANE_CHROME.height
  }
}

/** What `placePaneWithin` would give one more pane in `area`, in cells; `full` when it would give nothing. */
export function roomForNewPane(root: PaneNode | null, cell: Box, area: Box): NewPane | 'full' {
  const minPane = minPaneBox(cell)
  const placed = placePaneWithin(root, { kind: 'leaf', terminalId: PROBE_ID }, area, minPane)
  const size = placed ? paneCellsIn(placed, PROBE_ID, area, cell) : undefined
  return size === undefined ? 'full' : { ...size, area, minPane, cell }
}

/**
 * One cell of pane text as xterm will draw it, measured the way xterm measures the character.
 * Undefined when there is nothing to measure; callers then send no size.
 */
export function measureCell(fontSize: number, fontFamily: string, doc: Document | undefined): Box | undefined {
  const char = measureChar(fontSize, fontFamily, doc)
  return char && cellFromChar(char, doc?.defaultView?.devicePixelRatio || 1)
}

/** xterm's cell for a character: the WebGL renderer floors the width to device pixels and rounds the line. */
export function cellFromChar(char: Box, dpr: number): Box {
  return {
    width: Math.floor(char.width * dpr) / dpr,
    height: Math.floor(Math.ceil(char.height * dpr) * TERMINAL_LINE_HEIGHT) / dpr
  }
}

/** Canvas text metrics where there are any, as xterm prefers; a span otherwise. */
function measureChar(fontSize: number, fontFamily: string, doc: Document | undefined): Box | undefined {
  const body = doc?.body
  if (!body) return undefined
  const Offscreen = doc.defaultView?.OffscreenCanvas
  const context = Offscreen ? new Offscreen(1, 1).getContext('2d') : null
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`
    const metrics = context.measureText('W')
    const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
    if (metrics.width > 0 && height > 0) return { width: metrics.width, height }
  }
  const probe = doc.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = [
    'position:absolute',
    'top:-9999px',
    'left:-9999px',
    'white-space:pre',
    'visibility:hidden',
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    'line-height:normal'
  ].join(';')
  probe.textContent = 'W'.repeat(PROBE_COLUMNS)
  body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return { width: rect.width / PROBE_COLUMNS, height: rect.height }
}

/** The pane grid's content box and the least pane in it, as drawn now; nothing before there is a grid. */
export function paneGrid(
  fontSize: number,
  fontFamily: string,
  doc: Document | undefined = globalThis.document
): { area: Box; minPane: Box; cell: Box } | undefined {
  const grid = doc?.querySelector<HTMLElement>(PANE_GRID_SELECTOR)
  const view = doc?.defaultView
  const cell = measureCell(fontSize, fontFamily, doc)
  if (!grid || !view || !cell) return undefined
  const style = view.getComputedStyle(grid)
  const px = (value: string): number => Number.parseFloat(value) || 0
  const width = grid.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
  const height = grid.clientHeight - px(style.paddingTop) - px(style.paddingBottom)
  return width > 0 && height > 0 ? { area: { width, height }, minPane: minPaneBox(cell), cell } : undefined
}

/** `roomForNewPane` on the window's grid, or nothing when the window cannot answer; the runtime's default stands. */
export function newPaneRoom(
  fontSize: number,
  fontFamily: string,
  root: PaneNode | null,
  doc: Document | undefined = globalThis.document
): NewPane | 'full' | undefined {
  const grid = paneGrid(fontSize, fontFamily, doc)
  return grid && roomForNewPane(root, grid.cell, grid.area)
}
