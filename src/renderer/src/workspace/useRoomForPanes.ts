import { useLayoutEffect, useRef, useState } from 'react'
import type { PaneNode } from '@shared/entities'
import { minExtent, type Box } from '@shared/paneRoom'
import { foldsColumn } from '../panes/paneLayout'
import { useWorkspaceStore } from '../state/workspaceStore'
import { contentBox } from '../terminal/paneMetrics'
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

/** Whether the file column a split folded stays folded in `grid`; once the layout fits again it is drawn again. */
export function useFoldedColumn(grid: HTMLElement | null, root: PaneNode | null, minPane: Box | undefined): boolean {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const marked = useWorkspaceStore((state) => worktreeId !== null && state.foldedColumns[worktreeId] === true)
  const [folded, setFolded] = useState(false)

  useLayoutEffect(() => {
    if (!grid || !marked || !minPane || worktreeId === null) {
      setFolded(false)
      return
    }
    const check = (): void => {
      const box = contentBox(grid)
      if (!box) return
      const folds = foldsColumn(root, box, minPane)
      setFolded(folds)
      if (!folds) useWorkspaceStore.getState().unfoldColumn(worktreeId)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [grid, root, minPane, marked, worktreeId])

  return marked && folded
}
