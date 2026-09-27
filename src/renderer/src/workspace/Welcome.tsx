// The front door, with no worktree open: the mark, one first move (Open Folder…, or New Task… once there is a project)
// focused so Return takes it, the other ways to a project quieter beside it, the chords, and setup as one quiet line.

import { useEffect, useRef } from 'react'
import type { Project } from '@shared/entities'
import { Icon, type IconName } from '../icons/Icon'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, shortcutKeys, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { menuLabel } from '../menu/menuBar'
import { BrandMark } from '../shell/Brand'
import { useWorkspaceStore } from '../state/workspaceStore'
import { SetupSummary } from './SetupRows'

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
  const newProject = useWorkspaceStore((state) => state.newProject)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  const primary = useRef<HTMLButtonElement | null>(null)
  const firstRun = project === undefined

  // Only into a window where nothing has focus: a welcome that appears under the sidebar's keyboard leaves it there.
  useEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) primary.current?.focus()
  }, [firstRun])

  const quiet = (icon: IconName, label: string, onClick: () => void): React.JSX.Element => (
    <button type="button" className="button button--lead welcome__other" onClick={onClick}>
      <Icon name={icon} />
      {label}
    </button>
  )

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
              className="button button--primary button--lead welcome__first"
              ref={primary}
              onClick={() => void chooseProjectFolder()}
            >
              <Icon name="open-folder" />
              Open Folder…
            </button>
            <div className="welcome__others">
              {quiet('new-project', 'New Project…', () => void newProject())}
              {quiet('clone', 'Clone Repository…', () => openDialog({ kind: 'clone-project' }))}
              {quiet('team', 'Join a Team…', () => openDialog({ kind: 'join-invitation' }))}
            </div>
          </>
        ) : (
          <button
            type="button"
            className="button button--primary button--lead welcome__first"
            ref={primary}
            title={`New Task · ${shortcutHint('new-worktree', modifier)}`}
            onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
          >
            <Icon name="new-task" />
            New Task…
          </button>
        )}
      </div>

      {firstRun ? <SetupSummary /> : null}

      <dl className="welcome__shortcuts">
        {SHORTCUT_COMMANDS.map((command) => (
          <div key={command} data-command={command}>
            <dt>{menuLabel(command, { sidebarVisible, rightPanelOpen })}</dt>
            <dd>
              <kbd>
                {shortcutKeys(command, modifier).map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
