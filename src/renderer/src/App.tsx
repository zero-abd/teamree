// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useMemo } from 'react'
import { AddProjectDialog } from './dialogs/AddProjectDialog'
import { TaskComposerDialog } from './dialogs/TaskComposerDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { ConfirmRemoveDialog } from './dialogs/ConfirmRemoveDialog'
import { MembersDialog } from './dialogs/MembersDialog'
import { CommandPalette } from './palette/CommandPalette'
import { Sidebar } from './sidebar/Sidebar'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { useWorkspaceStore } from './state/workspaceStore'
import { WorkspaceArea } from './workspace/WorkspaceArea'

export function App(): React.JSX.Element {
  const modifier = useMemo(
    () =>
      resolvePlatformModifier(
        detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent)
      ),
    []
  )
  const isAppChord = useWorkspaceShortcuts(modifier)

  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const dialog = useWorkspaceStore((state) => state.dialog)
  const notices = useWorkspaceStore((state) => state.notices)
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice)

  // One subscription for the whole window: the runtime says what changed and
  // the store re-reads it, so work done in another window or from the CLI shows
  // up here on its own. Started before the first read, because an event that
  // arrives during bootstrap must not be missed.
  useEffect(() => {
    const stopWatching = useWorkspaceStore.getState().startWatching()
    void useWorkspaceStore.getState().bootstrap()
    return stopWatching
  }, [])

  return (
    <div
      className={`shell${sidebarVisible ? '' : ' shell--collapsed'}`}
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
    >
      {sidebarVisible ? (
        <>
          <Sidebar newWorktreeHint={shortcutHint('new-worktree', modifier)} />
          <SidebarResizer />
        </>
      ) : null}

      <WorkspaceArea modifier={modifier} isAppChord={isAppChord} />

      <StatusBar modifier={modifier} />

      {notices.length > 0 ? (
        <div className="notices" role="status" aria-live="polite">
          {notices.map((notice) => (
            <div className={`notice notice--${notice.tone}`} key={notice.id}>
              <span className="notice__text">{notice.text}</span>
              <button
                type="button"
                className="notice__close"
                aria-label="Dismiss message"
                onClick={() => dismissNotice(notice.id)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 3 L9 9 M9 3 L3 9" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {dialog?.kind === 'palette' ? <CommandPalette modifier={modifier} /> : null}
      {dialog?.kind === 'confirm-remove' ? (
        <ConfirmRemoveDialog worktreeId={dialog.worktreeId} reason={dialog.reason} />
      ) : null}
      {dialog?.kind === 'add-project' ? <AddProjectDialog /> : null}
      {dialog?.kind === 'members' ? <MembersDialog projectId={dialog.projectId} /> : null}
      {dialog?.kind === 'new-task' ? <TaskComposerDialog projectId={dialog.projectId} /> : null}
    </div>
  )
}
