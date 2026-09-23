// How big a pane will be, in cells, before there is a pane to ask. Without a size the pty starts
// 80x24 and a full-screen agent draws its first frame at the wrong width; the refit on mount fixes
// any cell this misses.

import type { PaneNode } from '@shared/entities'
import { TERMINAL_FONT_FAMILY } from './terminalTheme'

/** The line height every pane's emulator is built with. Stated once. */
export const TERMINAL_LINE_HEIGHT = 1.25

export type PaneSize = { cols: number; rows: number }

/** A box in CSS pixels; the part of a DOMRect anything here reads. */
export type Box = { width: number; height: number }

/** The fraction of the pane grid a pane occupies, per axis. */
export type PaneShare = { width: number; height: number }

/** xterm refuses to go below this, and so does the fit addon. */
const MIN_CELLS = 2

/** Characters in the probe; a run averages away per-glyph pixel rounding. */
const PROBE_COLUMNS = 80

/** Where the pane grid is drawn; `WorkspaceArea` owns the element. */
export const PANE_GRID_SELECTOR = '.workspace__panes'

/**
 * Pixels between a pane's edge and its first cell, mirroring `panes.css` (borders, 24px title bar,
 * hairline, padding). Stated because the first pane has nothing on screen to measure.
 */
export const PANE_CHROME: Box = { width: 1 + 1 + 9 + 6, height: 1 + 24 + 1 + 1 + 6 + 6 }

/** The share of the grid a pane appended now would get, by the same rule `appendPane` applies. */
export function appendedPaneShare(root: PaneNode | null): PaneShare {
  if (root === null) return { width: 1, height: 1 }
  if (root.kind === 'split' && root.direction === 'row') {
    return { width: 1 / (root.children.length + 1), height: 1 }
  }
  return { width: 0.5, height: 1 }
}

/** Cells that fit in a share of a box as the fit addon counts them: floor, never below two. */
export function paneSizeFrom(box: Box, cell: Box, share: PaneShare = { width: 1, height: 1 }): PaneSize | undefined {
  if (box.width <= 0 || box.height <= 0 || cell.width <= 0 || cell.height <= 0) return undefined
  return {
    cols: Math.max(MIN_CELLS, Math.floor((box.width * share.width) / cell.width)),
    rows: Math.max(MIN_CELLS, Math.floor((box.height * share.height) / cell.height))
  }
}

/**
 * One cell of pane text, measured with the emulator's font stack, line height applied after as xterm
 * does. Undefined when there is nothing to measure; callers then send no size.
 */
export function measureCell(fontSize: number, doc: Document | undefined): Box | undefined {
  const body = doc?.body
  if (!body) return undefined
  const probe = doc.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = [
    'position:absolute',
    'top:-9999px',
    'left:-9999px',
    'white-space:pre',
    'visibility:hidden',
    `font-family:${TERMINAL_FONT_FAMILY}`,
    `font-size:${fontSize}px`,
    'line-height:normal'
  ].join(';')
  probe.textContent = 'W'.repeat(PROBE_COLUMNS)
  body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return { width: rect.width / PROBE_COLUMNS, height: rect.height * TERMINAL_LINE_HEIGHT }
}

/** The size to open a pane at, or nothing when the window cannot answer; the runtime default stands. */
export function newPaneSize(
  fontSize: number,
  root: PaneNode | null,
  doc: Document | undefined = globalThis.document
): PaneSize | undefined {
  const grid = doc?.querySelector(PANE_GRID_SELECTOR)
  if (!grid) return undefined
  const cell = measureCell(fontSize, doc)
  if (!cell) return undefined
  const box = grid.getBoundingClientRect()
  const share = appendedPaneShare(root)
  // Chrome comes off each pane after the share: two panes carry two sets of borders.
  return paneSizeFrom(
    { width: box.width * share.width - PANE_CHROME.width, height: box.height * share.height - PANE_CHROME.height },
    cell
  )
}
