// What the window gives up so every pane keeps its floor (`MIN_PANE_CELLS`): the right panel folds
// to its rail first, then the sidebar goes. Pure, in CSS pixels, mirroring `shell.css` and `rightPanel.css`.

/** The closed panel's rail. */
export const RAIL_PX = 30

/** Where `rightPanel.css` lays the open panel over the panes instead of beside them. */
export const PANEL_OVERLAY_QUERY = '(width < 1200px)'

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
  return shown
}
