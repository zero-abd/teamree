// The front door, with no worktree open: the mark, the two ways to a project, New task once there is one,
// and three chords. No agent buttons and no headline; the buttons carry the meaning.

import type { Project } from '@shared/entities'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { menuLabel } from '../menu/menuBar'
import { BrandMark } from '../shell/Brand'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'

export const REPOSITORY_URL = 'https://github.com/zero-abd/teamree'

/** The three chords worth knowing first, as commands so label and key come from the menu's table. */
const SHORTCUT_COMMANDS: readonly WorkspaceCommand[] = ['new-worktree', 'open-palette', 'toggle-sidebar']

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
        <button
          type="button"
          className={project === undefined ? 'button button--primary button--lead' : 'button button--lead'}
          onClick={() => void chooseProjectFolder()}
        >
          Open Folder…
        </button>
        <button type="button" className="button button--lead" onClick={() => openDialog({ kind: 'clone-project' })}>
          Clone…
        </button>
        {/* Only once there is a project for the composer to make the worktree in. */}
        {project === undefined ? null : (
          <button
            type="button"
            className="button button--primary button--lead"
            onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
          >
            New task
          </button>
        )}
      </div>

      <dl className="welcome__shortcuts">
        {SHORTCUT_COMMANDS.map((command) => (
          <div key={command} data-command={command}>
            <dt>{menuLabel(command, { sidebarVisible, rightPanelOpen })}</dt>
            <dd>
              <kbd>{shortcutHint(command, modifier)}</kbd>
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        className="button button--small welcome__star"
        onClick={() => openInBrowser(REPOSITORY_URL)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1.2 7.45 4.2 10.7 4.65 8.35 6.95 8.9 10.2 6 8.65 3.1 10.2 3.65 6.95 1.3 4.65 4.55 4.2Z" />
        </svg>
        Star on GitHub
      </button>
    </div>
  )
}
