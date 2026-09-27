// A strip at the edge of a right panel laid over the panes, naming each pane it hides; a click folds the panel.

import { useLayoutEffect, useMemo, useState } from 'react'
import type { PaneNode } from '@shared/entities'
import { paneRects } from '@shared/paneRoom'
import { useWorkspaceStore } from '../state/workspaceStore'
import { contentBox } from '../terminal/paneMetrics'
import type { WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { paneStops } from '../panes/paneLayout'
import { paneTabs } from './paneTabs'
import { coveredPanes } from './roomForPanes'

type Strip = { id: string; top: number; height: number }

export function CoveredPanes({
  grid,
  root,
  worktree
}: {
  grid: HTMLElement | null
  root: PaneNode | null
  worktree: WorktreeNameSource
}): React.JSX.Element | null {
  const panelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  const panelWidth = useWorkspaceStore((state) => state.rightPanelWidth)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const foldPanel = useWorkspaceStore((state) => state.foldPanel)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const [strips, setStrips] = useState<{ right: number; panes: Strip[] }>({ right: 0, panes: [] })

  useLayoutEffect(() => {
    const body = grid?.parentElement
    if (!grid || !body || !root || !panelOpen) {
      setStrips({ right: 0, panes: [] })
      return
    }
    const check = (): void => {
      const panel = body.querySelector<HTMLElement>('.panel:not(.panel--closed)')
      const box = contentBox(grid)
      if (!panel || !box) return setStrips({ right: 0, panes: [] })
      // In the body's scrolled coordinates: the panel's slide-in can scroll the body while it runs.
      const style = getComputedStyle(grid)
      const gridRect = grid.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const left = gridRect.left - bodyRect.left + body.scrollLeft + Number.parseFloat(style.paddingLeft)
      const top = gridRect.top - bodyRect.top + body.scrollTop + Number.parseFloat(style.paddingTop)
      const edge = body.clientWidth - panel.offsetWidth - left
      // One strip per group, named by the tab it shows.
      const shown = new Set(paneStops(root))
      const rects = paneRects(root, box).filter((rect) => shown.has(rect.id))
      const panes = coveredPanes(rects, edge).map((rect) => ({
        id: rect.id,
        top: top + rect.y,
        height: rect.height
      }))
      setStrips({ right: panel.offsetWidth, panes })
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [grid, root, panelOpen, panelWidth])

  const names = useMemo(
    () => new Map(paneTabs(root, terminals, worktree).map((tab) => [tab.terminalId, tab.label])),
    [root, terminals, worktree]
  )
  const shown = strips.panes.filter((strip) => names.has(strip.id))
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((strip) => (
        <button
          key={strip.id}
          type="button"
          className="covered-pane"
          style={{ top: strip.top, height: strip.height, right: strips.right }}
          title={names.get(strip.id)}
          onClick={() => {
            foldPanel()
            focusPane(strip.id)
          }}
        >
          <span className="covered-pane__name">{names.get(strip.id)}</span>
        </button>
      ))}
    </>
  )
}
