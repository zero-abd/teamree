// The arithmetic behind "open this pane the size it is going to be".
//
// Kept apart from the DOM reading above it so the two questions are answered
// separately: what share of the grid a new pane gets, which is a fact about
// `appendPane` and is asserted here against the same rule; and how many cells
// fit in a box, which is the fit addon's own floor-and-never-below-two.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { appendedPaneShare, measureCell, newPaneSize, PANE_CHROME, paneSizeFrom } from './paneMetrics'

const CELL = { width: 8, height: 17 }

function leaf(terminalId: string): PaneNode {
  return { kind: 'leaf', terminalId }
}

describe('the share of the grid a new pane takes', () => {
  it('gives the whole grid to the first pane in a worktree', () => {
    expect(appendedPaneShare(null)).toEqual({ width: 1, height: 1 })
  })

  it('halves the grid when there is one pane to divide', () => {
    expect(appendedPaneShare(leaf('t1'))).toEqual({ width: 0.5, height: 1 })
  })

  it('joins an existing row as one more equal column', () => {
    const row: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('t1'), leaf('t2')]
    }
    // `appendPane` gives the newcomer 1/(children+1) and scales the rest, so a
    // third pane in a row of two is a third of the width.
    expect(appendedPaneShare(row)).toEqual({ width: 1 / 3, height: 1 })
  })

  it('halves a column split rather than joining it, because appendPane does', () => {
    const column: PaneNode = {
      kind: 'split',
      direction: 'column',
      sizes: [0.5, 0.5],
      children: [leaf('t1'), leaf('t2')]
    }
    expect(appendedPaneShare(column)).toEqual({ width: 0.5, height: 1 })
  })
})

describe('cells in a box', () => {
  it('floors, the way the fit addon does', () => {
    expect(paneSizeFrom({ width: 1279, height: 799 }, CELL)).toEqual({ cols: 159, rows: 47 })
  })

  it('counts only the share the pane will occupy', () => {
    expect(paneSizeFrom({ width: 1280, height: 800 }, CELL, { width: 0.5, height: 1 })).toEqual({ cols: 80, rows: 47 })
  })

  it('never goes below the two cells xterm insists on', () => {
    expect(paneSizeFrom({ width: 4, height: 4 }, CELL)).toEqual({ cols: 2, rows: 2 })
  })

  it('answers nothing for a box that has not been laid out', () => {
    expect(paneSizeFrom({ width: 0, height: 0 }, CELL)).toBeUndefined()
    expect(paneSizeFrom({ width: 1280, height: 800 }, { width: 0, height: 0 })).toBeUndefined()
  })
})

describe('with no window to measure', () => {
  // Every caller treats nothing as "send no size", which leaves the runtime's
  // own default — so this is the branch that has to stay quiet rather than
  // throw in a headless renderer test, a bootstrap before the grid exists, or
  // the first paint.
  it('measures no cell without a document', () => {
    expect(measureCell(13, 'monospace', undefined)).toBeUndefined()
  })

  it('offers no size without a document', () => {
    expect(newPaneSize(13, 'monospace', null, undefined)).toBeUndefined()
  })
})

describe('the chrome around a pane', () => {
  // The grid is not the text: a pane spends pixels on a border, a title bar and
  // the surface's padding before the first cell. Forgetting them cost three
  // rows of an agent's first frame, which is the whole point of measuring.
  it('comes off each pane rather than off the grid', () => {
    const grid = { width: 1000, height: 1000 }
    const whole = paneSizeFrom(
      { width: grid.width - PANE_CHROME.width, height: grid.height - PANE_CHROME.height },
      CELL
    )
    const halved = paneSizeFrom(
      { width: grid.width / 2 - PANE_CHROME.width, height: grid.height - PANE_CHROME.height },
      CELL
    )
    // Two panes side by side carry two borders, so half the grid is less than
    // half the cells.
    expect(halved!.cols).toBeLessThan(Math.floor(whole!.cols / 2))
  })
})
