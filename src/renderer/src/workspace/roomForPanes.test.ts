import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { minExtent } from '@shared/paneRoom'
import { minPaneBox } from '../terminal/paneMetrics'
import { panelCost, RAIL_PX, sidebarCost, toHide } from './roomForPanes'

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
