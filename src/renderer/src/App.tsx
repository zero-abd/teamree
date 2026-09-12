// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useMemo } from 'react'
import { AddProjectDialog } from './dialogs/AddProjectDialog'
import { CreateWorktreeDialog } from './dialogs/CreateWorktreeDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { Sidebar } from './sidebar/Sidebar'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { useWorkspaceStore } from './state/workspaceStore'
import { WorkspaceArea } from './workspace/WorkspaceArea'

/** Worktree creation has no push channel, so the shell re-reads on a timer. */
const POLL_MS = 2000

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

  useEffect(() => {
    void useWorkspaceStore.getState().bootstrap()
    const timer = setInterval(() => void useWorkspaceStore.getState().poll(), POLL_MS)
    return () => clearInterval(timer)
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

      {dialog?.kind === 'add-project' ? <AddProjectDialog /> : null}
      {dialog?.kind === 'create-worktree' ? <CreateWorktreeDialog projectId={dialog.projectId} /> : null}
    </div>
  )
}
