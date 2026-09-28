// The front door, with no worktree open. First run: the mark, Open Folder… focused so Return takes it, the
// other ways to a project quieter under it, three chords, and setup as one quiet line. With a project: New Task….

import { useEffect, useRef } from 'react'
import type { Project } from '@shared/entities'
import { NoAgentFound } from '../agents/NoAgentFound'
import { Icon, type IconName } from '../icons/Icon'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { menuLabel } from '../menu/menuBar'
import { MarkFull } from '../shell/Brand'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button, buttonClass } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Kbd } from '../ui/Kbd'
import { SetupSummary } from './SetupRows'

/** The chords worth knowing first, as commands so label and key come from the menu's table. */
const SHORTCUT_COMMANDS: readonly WorkspaceCommand[] = ['open-palette', 'new-worktree', 'toggle-sidebar']

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
  const hasWorktrees = useWorkspaceStore((state) =>
    state.worktrees.some((worktree) => worktree.projectId === project?.id)
  )
  const noAgent = useWorkspaceStore((state) => state.agentsProbed && state.agents.length === 0)
  const primary = useRef<HTMLButtonElement | null>(null)
  const firstRun = project === undefined

  // Only into a window where nothing has focus: a welcome that appears under the sidebar's keyboard leaves it there.
  // Again when Check Again takes its own button away.
  useEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) primary.current?.focus()
  }, [firstRun, noAgent])

  if (project !== undefined) {
    return (
      <div className="welcome welcome--project">
        <EmptyState
          title={hasWorktrees ? 'No worktree open' : 'No worktrees yet'}
          actions={
            <button
              type="button"
              className={buttonClass('primary', 'lg')}
              ref={primary}
              title={`New Task · ${shortcutHint('new-worktree', modifier)}`}
              onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
            >
              <Icon name="new-task" />
              New Task…
            </button>
          }
        />
        {noAgent ? <NoAgentFound /> : null}
      </div>
    )
  }

  const other = (icon: IconName, label: string, onClick: () => void): React.JSX.Element => (
    <Button icon={icon} onClick={onClick}>
      {label}
    </Button>
  )

  return (
    <div className="welcome">
      <div className="welcome__card">
        <span className="welcome__brand" aria-hidden="true">
          <span className="welcome__tile">
            <MarkFull size={60} />
          </span>
        </span>
        <span className="welcome__wordmark">
          teamree
          <span className="welcome__dot" aria-hidden="true">
            .
          </span>
        </span>

        <div className="welcome__actions">
          <button
            type="button"
            className={`${buttonClass('primary', 'lg')} welcome__first`}
            ref={primary}
            onClick={() => void chooseProjectFolder()}
          >
            <Icon name="open-folder" />
            Open Folder…
          </button>
          <div className="welcome__others">
            {other('new-project', 'New Project…', () => void newProject())}
            {other('clone', 'Clone Repository…', () => openDialog({ kind: 'clone-project' }))}
            {other('team', 'Join a Team…', () => openDialog({ kind: 'join-invitation' }))}
          </div>
        </div>

        <dl className="welcome__shortcuts">
          {SHORTCUT_COMMANDS.map((command) => (
            <div key={command} data-command={command}>
              <dt>{menuLabel(command, { sidebarVisible, rightPanelOpen })}</dt>
              <dd>
                <Kbd keys={[shortcutHint(command, modifier)]} />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="welcome__setup">
        {noAgent ? <NoAgentFound /> : null}
        <SetupSummary except={noAgent ? 'agents' : undefined} />
      </div>
    </div>
  )
}
