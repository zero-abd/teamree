import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { MIN_PANE_CELLS, minExtent, paneRects } from '@shared/paneRoom'
import { SIDEBAR_MIN_PX } from '../shell/sidebarWidth'
import { minPaneBox, roomForNewPane, zoomedPaneSize } from '../terminal/paneMetrics'
import { coveredPanes, panelCost, panelYields, RAIL_PX, sidebarCost, toHide } from './roomForPanes'

const leaf = (id: string): PaneNode => ({ kind: 'leaf', terminalId: id })
const column = (...children: PaneNode[]): PaneNode => ({
  kind: 'split',
  direction: 'column',
  sizes: children.map(() => 1 / children.length),
  children
})
const both = { panel: true, sidebar: true }

describe('toHide', () => {
  const costs = { panel: 300, sidebar: 250 }

  it('hides nothing when the panes fit as they are', () => {
    expect(toHide(1000, 450, costs, both)).toEqual({ panel: false, sidebar: false })
  })

  it('folds the panel first', () => {
    expect(toHide(1000, 500, costs, both)).toEqual({ panel: true, sidebar: false })
  })

  it('then the sidebar', () => {
    expect(toHide(1000, 800, costs, both)).toEqual({ panel: true, sidebar: true })
    expect(toHide(1000, 800, costs, { panel: false, sidebar: true })).toEqual({ panel: false, sidebar: true })
  })

  it('leaves a panel laid over the panes open: folding it gives them nothing', () => {
    const overlaid = { panel: 0, sidebar: 250 }
    expect(toHide(1000, 800, overlaid, both)).toEqual({ panel: false, sidebar: true })
    expect(toHide(1000, 2000, overlaid, both)).toEqual({ panel: false, sidebar: true })
  })

  it('never hides what is not shown', () => {
    expect(toHide(1000, 2000, costs, { panel: false, sidebar: false })).toEqual({ panel: false, sidebar: false })
    expect(toHide(1000, 800, costs, { panel: true, sidebar: false })).toEqual({ panel: true, sidebar: false })
  })
})

describe('the room rule at 1024 px', () => {
  // Measured on the built app at 1024x700: 6.75px cells, a 272px sidebar, a 340px panel,
  // three shells beside a file column over a fourth; the grid got 386px and each shell 25 columns.
  const minPane = minPaneBox({ width: 6.75, height: 16.25 })
  const root: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [column(leaf('t1'), leaf('t2'), leaf('t3')), column(leaf('file:a'), leaf('t4'))]
  }
  const costs = { panel: panelCost(340), sidebar: sidebarCost(272, 1024) }
  const free = 386 + costs.panel + costs.sidebar

  it('gives every shell 40 columns once the panel is a rail', () => {
    const hide = toHide(free, minExtent(root, 'row', minPane), costs, both)
    expect(hide).toEqual({ panel: true, sidebar: false })
    const grid = free - costs.sidebar
    const chrome = minPane.width - 40 * 6.75
    expect(Math.floor(((grid - 5) / 2 - chrome) / 6.75)).toBeGreaterThanOrEqual(40)
  })

  it('costs the panel its width over the rail, and the sidebar its capped column and seam', () => {
    expect(panelCost(340)).toBe(340 + 1 - RAIL_PX)
    expect(sidebarCost(272, 1024)).toBe(273)
    expect(sidebarCost(600, 1024)).toBeCloseTo(1024 * 0.45 + 1)
  })
})

describe('narrow windows', () => {
  // Measured cells at 13px; the sidebar at its narrowest, or hidden; the panel at its default 340px.
  const cell = { width: 6.75, height: 16.25 }
  const two: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
  const widths = [800, 1000, 1200, 1440]
  const sidebars = [SIDEBAR_MIN_PX, null]
  /** The grid's width with the panel open: laid over the panes below 1200px, beside them above. */
  const gridWidth = (window: number, sidebar: number | null): number =>
    window - (sidebar === null ? 0 : sidebarCost(sidebar, window)) - (panelYields(window, true) ? 0 : 341)

  it('folds an open panel before opening a pane only where it lays over the panes', () => {
    expect(widths.map((width) => panelYields(width, true))).toEqual([true, true, false, false])
    expect(widths.map((width) => panelYields(width, false))).toEqual([false, false, false, false])
  })

  // Two panes in a 300px-high grid: a third fits only in a row, at 3 x 287px and two gutters.
  it.each([
    [800, SIDEBAR_MIN_PX, true],
    [800, null, true],
    [1000, SIDEBAR_MIN_PX, true],
    [1000, null, false],
    [1200, SIDEBAR_MIN_PX, true],
    [1200, null, true],
    [1440, SIDEBAR_MIN_PX, false],
    [1440, null, false]
  ] as const)('at %i px, sidebar %s, a new pane opens zoomed: %s; never refused', (width, sidebar, zoomed) => {
    const area = { width: gridWidth(width, sidebar), height: 300 }
    const room = roomForNewPane(two, cell, area)
    const plan = room === 'full' ? { zoomed: true, ...zoomedPaneSize(area, cell) } : { zoomed: false, ...room }
    expect(plan.zoomed).toBe(zoomed)
    expect(plan.cols).toBeGreaterThanOrEqual(MIN_PANE_CELLS.cols)
    expect(plan.rows).toBeGreaterThanOrEqual(MIN_PANE_CELLS.rows)
  })

  it.each(widths.flatMap((width) => sidebars.map((sidebar) => [width, sidebar] as const)))(
    'at %i px, sidebar %s, names the pane an overlaid panel hides',
    (width, sidebar) => {
      const grid = gridWidth(width, sidebar)
      const rects = paneRects(two, { width: grid, height: 600 })
      const edge = panelYields(width, true) ? grid - 340 : grid
      expect(coveredPanes(rects, edge).map((rect) => rect.id)).toEqual(width < 1200 ? ['b'] : [])
    }
  )

  it('leaves a pane mostly in view unnamed', () => {
    const rects = [{ id: 'a', x: 0, y: 0, width: 600, height: 400 }]
    expect(coveredPanes(rects, 340)).toEqual([])
    expect(coveredPanes(rects, 290)).toEqual(rects)
  })
})
