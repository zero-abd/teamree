// Projects and their worktrees. The filter matches on task name and branch,
// which is how people actually look for a piece of work in flight.

import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { WorktreeRow } from './WorktreeRow'

export function Sidebar({ newWorktreeHint }: { newWorktreeHint: string }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const collapsed = useWorkspaceStore((state) => state.collapsedProjects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const toggleProject = useWorkspaceStore((state) => state.toggleProject)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const retryWorktree = useWorkspaceStore((state) => state.retryWorktree)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)

  const [filter, setFilter] = useState('')

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return worktrees
    return worktrees.filter(
      (worktree) => worktree.name.toLowerCase().includes(needle) || worktree.branch.toLowerCase().includes(needle)
    )
  }, [filter, worktrees])

  return (
    <nav className="sidebar" aria-label="Projects and worktrees">
      <div className="sidebar__head">
        <span className="wordmark">
          teamree
          <span className="wordmark__dot" aria-hidden="true" />
        </span>
        <button
          type="button"
          className="button button--ghost button--icon"
          title="Add project"
          aria-label="Add project"
          onClick={() => openDialog({ kind: 'add-project' })}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
          </svg>
        </button>
      </div>

      <div className="sidebar__filter">
        <input
          type="search"
          value={filter}
          placeholder="Filter worktrees"
          aria-label="Filter worktrees"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="sidebar__scroll">
        {projects.length === 0 ? (
          <p className="sidebar__empty">No projects yet. Add a repository to get started.</p>
        ) : null}

        {projects.map((project) => {
          const rows = matching.filter((worktree) => worktree.projectId === project.id)
          const isCollapsed = Boolean(collapsed[project.id])
          return (
            <section className="project" key={project.id}>
              <div className="project__head">
                <button
                  type="button"
                  className="project__toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleProject(project.id)}
                >
                  <svg
                    className={`chevron${isCollapsed ? '' : ' chevron--open'}`}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
                  </svg>
                  <span className="project__name">{project.name}</span>
                  <span className="project__count">{rows.length}</span>
                </button>
                <button
                  type="button"
                  className="button button--ghost button--icon"
                  title={`New worktree in ${project.name} · ${newWorktreeHint}`}
                  aria-label={`New worktree in ${project.name}`}
                  onClick={() => openDialog({ kind: 'create-worktree', projectId: project.id })}
                >
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
                  </svg>
                </button>
              </div>
              <p className="project__base">{project.baseRef}</p>

              {isCollapsed ? null : (
                <ul className="project__worktrees">
                  {rows.map((worktree) => (
                    <WorktreeRow
                      key={worktree.id}
                      worktree={worktree}
                      status={statuses[worktree.id]}
                      mergePreview={mergePreviews[worktree.id]}
                      active={worktree.id === activeWorktreeId}
                      onOpen={() => void openWorktree(worktree.id)}
                      onRetry={() => retryWorktree(worktree.id)}
                      onRemove={() => void removeWorktree(worktree.id)}
                    />
                  ))}
                  {rows.length === 0 ? (
                    <li className="project__none">
                      {filter.trim().length > 0 ? (
                        'No worktrees match that.'
                      ) : (
                        <>
                          {'No worktrees yet. '}
                          <button
                            type="button"
                            className="project__none-action"
                            onClick={() => openDialog({ kind: 'create-worktree', projectId: project.id })}
                          >
                            Start one
                          </button>
                        </>
                      )}
                    </li>
                  ) : null}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </nav>
  )
}
