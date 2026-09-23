// The sidebar's edge: `EdgeResizer`, bound to the sidebar's width.

import { useWorkspaceStore } from '../state/workspaceStore'
import { EdgeResizer } from './EdgeResizer'
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX } from './sidebarWidth'

export function SidebarResizer(): React.JSX.Element {
  const width = useWorkspaceStore((state) => state.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((state) => state.setSidebarWidth)

  return (
    <EdgeResizer
      className="shell__resizer"
      label="Resize sidebar"
      width={width}
      min={SIDEBAR_MIN_PX}
      max={SIDEBAR_MAX_PX}
      onWidth={setSidebarWidth}
      grows="rightward"
      resetTo={SIDEBAR_MIN_PX}
    />
  )
}
