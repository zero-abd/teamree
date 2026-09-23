// How big a pane is, in cells, before there is a pane to ask.
//
// A pty is spawned with a size, and a program that draws a whole screen —
// every agent this app starts — reads it once and lays its frame out to it.
// `terminal.create` used to carry no size at all, so the pty was born 80x24 and
// the emulator told it the truth a frame later, by which time the agent had
// already drawn at the wrong width: a pane of wrapped lines with a column of
// debris down the right edge, which stayed until the next resize moved it.
//
// So the window measures first and says. It can: the pane grid is on screen,
// the fraction of it the new pane will take is decided by `appendPane`, and a
// cell is a box of text in a font this window already knows. None of that is
// available in the runtime, which is why the size travels with the call.
//
// The measurement is not expected to be exact — the emulator refits on mount
// and corrects whatever this missed by a cell. It is expected to be the right
// shape, which 80x24 never is.

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

/**
 * Characters in the probe. A run rather than one letter, because a single
 * glyph's box is rounded to the pixel and eighty of them average that away.
 */
const PROBE_COLUMNS = 80

/** Where the pane grid is drawn; `WorkspaceArea` owns the element. */
export const PANE_GRID_SELECTOR = '.workspace__panes'

/**
 * Everything between the edge of a pane and the first cell of text, in pixels.
 *
 * Mirrors `panes.css`, which owns these numbers: the pane's own 1px border on
 * each side, the 24px title bar and the hairline under it, and the surface's
 * padding (`--s3` on the left, `--s2` on the other three). Stated rather than
 * measured because the pane this matters most for is the first one in a
 * worktree, and there is nothing of its kind on screen to measure yet.
 *
 * Wrong by a pixel or two after a change to that stylesheet costs a column or
 * a row, which the refit on mount takes back. Wrong by forty — which is what
 * ignoring it altogether was — costs three rows of an agent's first frame.
 */
export const PANE_CHROME: Box = { width: 1 + 1 + 9 + 6, height: 1 + 24 + 1 + 1 + 6 + 6 }

/**
 * The share of the grid a pane appended now would get.
 *
 * Read off the same rule `appendPane` applies, because it is the same decision:
 * a new pane joins an existing row as one more equal column, and anything else
 * — no panes at all, one pane, a column split — is halved or taken whole.
 */
export function appendedPaneShare(root: PaneNode | null): PaneShare {
  if (root === null) return { width: 1, height: 1 }
  if (root.kind === 'split' && root.direction === 'row') {
    return { width: 1 / (root.children.length + 1), height: 1 }
  }
  return { width: 0.5, height: 1 }
}

/**
 * Cells that fit in a share of a box, the way the fit addon counts them: floor,
 * never below two, and the gutter between panes ignored — a cell of slack is
 * within what the refit on mount corrects anyway.
 */
export function paneSizeFrom(box: Box, cell: Box, share: PaneShare = { width: 1, height: 1 }): PaneSize | undefined {
  if (box.width <= 0 || box.height <= 0 || cell.width <= 0 || cell.height <= 0) return undefined
  return {
    cols: Math.max(MIN_CELLS, Math.floor((box.width * share.width) / cell.width)),
    rows: Math.max(MIN_CELLS, Math.floor((box.height * share.height) / cell.height))
  }
}

/**
 * One cell of pane text, measured in the document rather than assumed.
 *
 * The same font stack the emulator is built with, so this is a reading of the
 * thing itself rather than arithmetic on the font size — a monospace face's
 * line box is taller than its point size, by an amount only the face knows.
 * The probe is measured at its natural height and the emulator's line height
 * applied after, which is the order xterm does it in: it measures a character
 * and multiplies.
 *
 * Undefined where there is nothing to measure — no document, or a layout that
 * has not happened — and every caller treats that as "do not send a size",
 * which is the behaviour this file replaces.
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

/**
 * The size to open a pane at in this window, or nothing when the window cannot
 * answer — no grid on screen yet, a zero-sized box mid-layout, a headless
 * document. Nothing is the honest answer there, and the runtime's own default
 * stands until the view mounts and resizes.
 */
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
  // The chrome comes off each pane, not off the grid, so it is taken after the
  // share: two panes side by side carry two sets of borders.
  return paneSizeFrom(
    { width: box.width * share.width - PANE_CHROME.width, height: box.height * share.height - PANE_CHROME.height },
    cell
  )
}
