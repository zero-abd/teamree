// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useMemo } from 'react'
import { MAC_CONTENT_INSET_PX, TITLEBAR_HEIGHT_PX } from '@shared/windowChrome'
import { AddProjectDialog } from './dialogs/AddProjectDialog'
import { TaskComposerDialog } from './dialogs/TaskComposerDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { ConfirmRemoveDialog } from './dialogs/ConfirmRemoveDialog'
import { FirstRunCliOffer } from './dialogs/FirstRunCliOffer'
import { InstallCliDialog } from './dialogs/InstallCliDialog'
import { StartTeamworkDialog } from './dialogs/StartTeamworkDialog'
import { CommandPalette } from './palette/CommandPalette'
import { Sidebar } from './sidebar/Sidebar'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { TitleBar } from './shell/TitleBar'
import { useWorkspaceStore } from './state/workspaceStore'
import { WorkspaceArea } from './workspace/WorkspaceArea'

export function App(): React.JSX.Element {
  const platform = useMemo(
    () => detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent),
    []
  )
  const modifier = useMemo(() => resolvePlatformModifier(platform), [platform])
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
      style={{
        ['--sidebar-width' as string]: `${sidebarWidth}px`,
        // Both come from src/shared/windowChrome.ts, which the main process also
        // reads to place the macOS window buttons.
        ['--titlebar-h' as string]: `${TITLEBAR_HEIGHT_PX}px`,
        ['--titlebar-inset' as string]: `${MAC_CONTENT_INSET_PX}px`
      }}
    >
      <TitleBar platform={platform} />

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

      {/* Nothing is focused and nothing is blocked: the window is usable
          whether or not anybody answers this. */}
      <FirstRunCliOffer />

      {dialog?.kind === 'palette' ? <CommandPalette modifier={modifier} /> : null}
      {dialog?.kind === 'confirm-remove' ? (
        <ConfirmRemoveDialog worktreeId={dialog.worktreeId} reason={dialog.reason} />
      ) : null}
      {dialog?.kind === 'add-project' ? <AddProjectDialog /> : null}
      {dialog?.kind === 'install-cli' ? <InstallCliDialog /> : null}
      {dialog?.kind === 'start-teamwork' ? <StartTeamworkDialog projectId={dialog.projectId} /> : null}
      {dialog?.kind === 'new-task' ? <TaskComposerDialog projectId={dialog.projectId} /> : null}
    </div>
  )
}
