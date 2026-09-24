// The front door, with no worktree open: the mark, then the two ways to a project, or New Task once there
// is one (the sidebar's + adds more), and the chords. No agent buttons and no headline.

import type { Project } from '@shared/entities'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { menuLabel } from '../menu/menuBar'
import { BrandMark } from '../shell/Brand'
import { useWorkspaceStore } from '../state/workspaceStore'

/** The chords worth knowing first, as commands so label and key come from the menu's table. */
const SHORTCUT_COMMANDS: readonly WorkspaceCommand[] = ['open-palette', 'toggle-sidebar']

export function Welcome({
  modifier,
  project
}: {
  modifier: PlatformModifier
  /** Where a new task would go; undefined until a project has been added. */
  project: Project | undefined
}): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const chooseProjectFolder = useWorkspaceStore((state) => state.chooseProjectFolder)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen)

  return (
    <div className="welcome">
      <span className="brand__tile brand__tile--welcome" aria-hidden="true">
        <BrandMark />
      </span>
      <span className="wordmark wordmark--welcome">
        teamree
        <span className="wordmark__dot" aria-hidden="true" />
      </span>

      <div className="welcome__actions">
        {project === undefined ? (
          <>
            <button
              type="button"
              className="button button--primary button--lead"
              onClick={() => void chooseProjectFolder()}
            >
              Open Folder…
            </button>
            <button type="button" className="button button--lead" onClick={() => openDialog({ kind: 'clone-project' })}>
              Clone…
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--primary button--lead"
            onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
          >
            New Task
          </button>
        )}
      </div>

      <dl className="welcome__shortcuts">
        {(project === undefined ? SHORTCUT_COMMANDS : ['new-worktree' as const, ...SHORTCUT_COMMANDS]).map(
          (command) => (
            <div key={command} data-command={command}>
              <dt>{menuLabel(command, { sidebarVisible, rightPanelOpen })}</dt>
              <dd>
                <kbd>{shortcutHint(command, modifier)}</kbd>
              </dd>
            </div>
          )
        )}
      </dl>
    </div>
  )
}
