// The arithmetic behind "open this pane the size it is going to be".
//
// Kept apart from the DOM reading above it so the two questions are answered
// separately: where in the grid a new pane lands, which is `placePaneWithin`'s
// answer; and how many cells
// fit in a box, which is the fit addon's own floor-and-never-below-two.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { MIN_PANE_CELLS, PANE_BAR_PX, PANE_CHROME, paneSizeFrom } from '@shared/paneRoom'
import { GUTTER_PX } from '../panes/paneLayout'
import { cellFromChar, measureCell, minPaneBox, newPaneRoom, roomForNewPane } from './paneMetrics'

const CELL = { width: 8, height: 17 }

function leaf(terminalId: string): PaneNode {
  return { kind: 'leaf', terminalId }
}

describe('where the next pane lands', () => {
  const area = { width: 1000, height: 800 }

  // A lone pane draws no bar: its tab names it.
  it('gives the first pane in a worktree the whole grid, with no bar over it', () => {
    expect(roomForNewPane(null, CELL, area)).toEqual({
      ...paneSizeFrom({ width: 1000 - PANE_CHROME.width, height: 800 - PANE_CHROME.height + PANE_BAR_PX }, CELL),
      area,
      minPane: minPaneBox(CELL),
      cell: CELL
    })
  })

  it('measures the half of the largest pane it will take', () => {
    const room = roomForNewPane(leaf('t1'), CELL, area)
    expect(room).toMatchObject(
      paneSizeFrom({ width: (1000 - GUTTER_PX) / 2 - PANE_CHROME.width, height: 800 - PANE_CHROME.height }, CELL)!
    )
  })

  it('stacks rather than squeezing a pane under the minimum width', () => {
    const narrow = { width: 600, height: 500 }
    const room = roomForNewPane(leaf('t1'), CELL, narrow)
    expect(room).not.toBe('full')
    if (room !== 'full') expect(room.cols).toBeGreaterThan(MIN_PANE_CELLS.cols)
  })

  it('is full when every place leaves a pane under the minimum', () => {
    expect(roomForNewPane(leaf('t1'), CELL, { width: 600, height: 200 })).toBe('full')
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

describe('a cell as xterm draws it', () => {
  // The character is 7.83px wide at 13px, but xterm draws 7.5px cells on a 2x
  // screen: counted in the character's width, a pane was born 4% narrower than drawn.
  it('floors the width to device pixels and rounds the line as the WebGL renderer does', () => {
    expect(cellFromChar({ width: 7.82666015625, height: 15 }, 2)).toEqual({ width: 7.5, height: 18.5 })
    expect(cellFromChar({ width: 5.41845703125, height: 10 }, 2)).toEqual({ width: 5, height: 12.5 })
    expect(cellFromChar({ width: 7.82666015625, height: 15 }, 1)).toEqual({ width: 7, height: 18 })
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
    expect(newPaneRoom(13, 'monospace', null, undefined)).toBeUndefined()
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
