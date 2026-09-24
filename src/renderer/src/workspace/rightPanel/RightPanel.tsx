// The panel on the right of the panes: the worktree's files or its changes, one at a time.
//
// Per worktree in what it shows and per machine in how it is shown. Switching
// worktrees keeps the tab and the width and re-reads the content, which is
// what `key` on each tab does: a tree read for one checkout is not a tree of
// another, and a component keyed by the worktree is remounted rather than
// asked to notice.
//
// The rail is drawn even while the panel is closed, down the window's right
// edge, so the tabs stay findable — see `RightRail.tsx`.

import { EdgeResizer } from '../../shell/EdgeResizer'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
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
  const showRightPanelTab = useWorkspaceStore((state) => state.showRightPanelTab)
  const toggleRightPanel = useWorkspaceStore((state) => state.toggleRightPanel)
  const setRightPanelWidth = useWorkspaceStore((state) => state.setRightPanelWidth)

  if (!worktree) return null

  const rail = (
    <RightRail open={open} tab={tab} status={status} onPick={showRightPanelTab} onToggle={toggleRightPanel} />
  )

  // One aside open and closed, so its width slides between the rail's and the dragged one.
  return (
    <>
      {open ? (
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
      ) : null}
      <aside
        className={open ? 'panel' : 'panel panel--closed'}
        style={open ? { width: `${width}px` } : undefined}
        aria-label={open ? 'Right panel' : undefined}
        data-region="panel"
      >
        {rail}
        {open ? (
          <div className="panel__body" role="tabpanel">
            {tab === 'files' ? <FilesTab key={worktree.id} worktree={worktree} /> : null}
            {tab === 'changes' ? <ChangesTab /> : null}
          </div>
        ) : null}
      </aside>
    </>
  )
}
