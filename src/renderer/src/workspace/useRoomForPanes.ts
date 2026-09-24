import { useLayoutEffect, useRef } from 'react'
import type { PaneNode } from '@shared/entities'
import { minExtent, type Box } from '@shared/paneRoom'
import { useWorkspaceStore } from '../state/workspaceStore'
import { panelCost, sidebarCost, toHide, type Sides } from './roomForPanes'

/**
 * Folds the panel, then the sidebar, while `root` in `grid` cannot give every pane `minPane`, and shows
 * them again when it can. Acts only when that answer changes, so a side shown again by hand stays.
 */
export function useRoomForPanes(grid: HTMLElement | null, root: PaneNode | null, minPane: Box | undefined): void {
  const panelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const panelWidth = useWorkspaceStore((state) => state.rightPanelWidth)
  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const hidden = useRef<Sides>(useWorkspaceStore.getState().roomHid)

  useLayoutEffect(() => {
    if (!grid || !root || !minPane) return
    const need = minExtent(root, 'row', minPane)
    const check = (): void => {
      // Not laid out (hidden, or a test document): nothing to measure against.
      if (grid.clientWidth === 0) return
      const state = useWorkspaceStore.getState()
      const style = getComputedStyle(grid)
      const width = grid.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      // An open panel is measured: `rightPanel.css` caps it below the width it was dragged to.
      const panel = grid.ownerDocument.querySelector<HTMLElement>('.panel:not(.panel--closed)')
      const costs = {
        panel: panel ? panelCost(panel.getBoundingClientRect().width) : panelCost(state.rightPanelWidth),
        sidebar: sidebarCost(state.sidebarWidth, window.innerWidth)
      }
      const free = width + (state.rightPanelOpen ? costs.panel : 0) + (state.sidebarVisible ? costs.sidebar : 0)
      const wants = {
        panel: state.rightPanelOpen || state.roomHid.panel,
        sidebar: state.sidebarVisible || state.roomHid.sidebar
      }
      const next = toHide(free, need, costs, wants)
      if (next.panel === hidden.current.panel && next.sidebar === hidden.current.sidebar) return
      hidden.current = next
      state.makeRoom(next)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [grid, root, minPane, panelOpen, sidebarVisible, panelWidth, sidebarWidth])
}
