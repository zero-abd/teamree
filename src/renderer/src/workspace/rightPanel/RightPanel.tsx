// The panel on the right of the panes: the worktree's files, its changes, and
// its panes, one at a time.
//
// Per worktree in what it shows and per machine in how it is shown. Switching
// worktrees keeps the tab and the width and re-reads the content, which is
// what `key` on each tab does: a tree read for one checkout is not a tree of
// another, and a component keyed by the worktree is remounted rather than
// asked to notice.
//
// The rail is drawn even while the panel is closed, down the window's right
// edge, so the three tabs stay findable — see `RightRail.tsx`.

import { collectTerminalIds } from '../../panes/paneLayout'
import { EdgeResizer } from '../../shell/EdgeResizer'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
import { PanesTab } from './PanesTab'
import { RightRail } from './RightRail'
import { RIGHT_PANEL_DEFAULT_PX, RIGHT_PANEL_MAX_PX, RIGHT_PANEL_MIN_PX } from './rightPanelState'

export function RightPanel(): React.JSX.Element | null {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const open = useWorkspaceStore((state) => state.rightPanelOpen)
  const tab = useWorkspaceStore((state) => state.rightPanelTab)
  const width = useWorkspaceStore((state) => state.rightPanelWidth)
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const paneCount = useWorkspaceStore((state) =>
    state.activeWorktreeId ? collectTerminalIds(state.layouts[state.activeWorktreeId]?.root ?? null).length : 0
  )
  const showRightPanelTab = useWorkspaceStore((state) => state.showRightPanelTab)
  const toggleRightPanel = useWorkspaceStore((state) => state.toggleRightPanel)
  const setRightPanelWidth = useWorkspaceStore((state) => state.setRightPanelWidth)

  if (!worktree) return null

  const rail = (
    <RightRail
      open={open}
      tab={tab}
      status={status}
      panes={paneCount}
      onPick={showRightPanelTab}
      onToggle={toggleRightPanel}
    />
  )

  if (!open) return <aside className="panel panel--closed">{rail}</aside>

  return (
    <>
      <EdgeResizer
        className="panel__resizer"
        label="Resize right panel"
        width={width}
        min={RIGHT_PANEL_MIN_PX}
        max={RIGHT_PANEL_MAX_PX}
        onWidth={setRightPanelWidth}
        grows="leftward"
        resetTo={RIGHT_PANEL_DEFAULT_PX}
      />
      <aside className="panel" style={{ width: `${width}px` }} aria-label="Right panel">
        {rail}
        <div className="panel__body" role="tabpanel">
          {tab === 'files' ? <FilesTab key={worktree.id} worktree={worktree} /> : null}
          {tab === 'changes' ? <ChangesTab /> : null}
          {tab === 'panes' ? <PanesTab key={worktree.id} worktree={worktree} /> : null}
        </div>
      </aside>
    </>
  )
}
