// What the window gives up so every pane keeps its floor (`MIN_PANE_CELLS`): the right panel folds
// to its rail first, then the sidebar goes. Pure, in CSS pixels, mirroring `shell.css` and `rightPanel.css`.

import type { PaneRect } from '@shared/paneRoom'

/** The closed panel's rail. */
export const RAIL_PX = 30

/** Below this window width `rightPanel.css` lays the open panel over the panes instead of beside them. */
const PANEL_OVERLAY_BELOW_PX = 1200

/** `PANEL_OVERLAY_BELOW_PX` as the media query the stylesheet states. */
export const PANEL_OVERLAY_QUERY = `(width < ${PANEL_OVERLAY_BELOW_PX}px)`

/** The sidebar's cap, as a share of the window. */
const SIDEBAR_MAX_SHARE = 0.45

export type Sides = { panel: boolean; sidebar: boolean }
export type Costs = { panel: number; sidebar: number }

/** Pixels an open panel takes from the panes over its rail: its width and the seam, less the rail. */
export function panelCost(width: number): number {
  return width + 1 - RAIL_PX
}

/** Pixels a shown sidebar takes from the panes: its capped column and the seam. */
export function sidebarCost(width: number, windowWidth: number): number {
  return Math.min(width, windowWidth * SIDEBAR_MAX_SHARE) + 1
}

/** Which of the `shown` sides to hide so `need` fits in `free`, the grid's width with both hidden. */
export function toHide(free: number, need: number, costs: Costs, shown: Sides): Sides {
  const fits = (panel: boolean, sidebar: boolean): boolean =>
    free - (panel ? costs.panel : 0) - (sidebar ? costs.sidebar : 0) >= need
  if (fits(shown.panel, shown.sidebar)) return { panel: false, sidebar: false }
  if (shown.panel && fits(false, shown.sidebar)) return { panel: true, sidebar: false }
  // A panel laid over the panes costs them nothing, so it never folds for room.
  return { panel: shown.panel && costs.panel > 0, sidebar: shown.sidebar }
}

/** Whether opening a pane folds the open panel first: laid over the panes, it would cover what it opened. */
export function panelYields(windowWidth: number, panelOpen: boolean): boolean {
  return panelOpen && windowWidth < PANEL_OVERLAY_BELOW_PX
}

/** The panes a panel laid over the grid from `edge`, in grid pixels, hides more than half of. */
export function coveredPanes(rects: readonly PaneRect[], edge: number): PaneRect[] {
  return rects.filter((rect) => rect.x + rect.width / 2 > edge)
}
