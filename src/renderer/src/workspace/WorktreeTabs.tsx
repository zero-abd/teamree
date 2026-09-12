// Open worktrees. Each tab keeps its own pane layout, so switching is just a
// change of which tree is mounted.

import { useWorkspaceStore } from '../state/workspaceStore'

export function WorktreeTabs(): React.JSX.Element | null {
  const openWorktreeIds = useWorkspaceStore((state) => state.openWorktreeIds)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const closeWorktreeTab = useWorkspaceStore((state) => state.closeWorktreeTab)

  if (openWorktreeIds.length === 0) return null

  return (
    <div className="tabs" role="tablist" aria-label="Open worktrees">
      {openWorktreeIds.map((id) => {
        const worktree = worktrees.find((entry) => entry.id === id)
        if (!worktree) return null
        const active = id === activeWorktreeId
        return (
          <div className={`tab${active ? ' tab--active' : ''}`} key={id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab__main"
              onClick={() => void openWorktree(id)}
            >
              <span className="tab__name">{worktree.name}</span>
              <span className="tab__branch">{worktree.branch}</span>
            </button>
            <button
              type="button"
              className="tab__close"
              title={`Close ${worktree.name}`}
              aria-label={`Close tab ${worktree.name}`}
              onClick={() => closeWorktreeTab(id)}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 3 L9 9 M9 3 L3 9" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
