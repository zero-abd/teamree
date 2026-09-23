// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useLayoutEffect, useMemo } from 'react'
import { resolvePalette } from '@shared/theme'
import { MAC_CONTENT_INSET_PX, TITLEBAR_HEIGHT_PX } from '@shared/windowChrome'
import { AddProjectDialog } from './dialogs/AddProjectDialog'
import { AppearanceDialog } from './dialogs/AppearanceDialog'
import { TaskComposerDialog } from './dialogs/TaskComposerDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { useMenuBar } from './menu/useMenuBar'
import { useAgentNotices } from './notices/useAgentNotices'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { ConfirmClosePaneDialog } from './dialogs/ConfirmClosePaneDialog'
import { ConfirmRemoveDialog } from './dialogs/ConfirmRemoveDialog'
import { FirstRunCliOffer } from './dialogs/FirstRunCliOffer'
import { InstallCliDialog } from './dialogs/InstallCliDialog'
import { firstQuestion } from './dialogs/modalLayer'
import { RemoteKeystrokesDialog } from './dialogs/RemoteKeystrokesDialog'
import { CommandPalette } from './palette/CommandPalette'
import { Sidebar } from './sidebar/Sidebar'
import { openInBrowser } from './shell/openInBrowser'
import { shellClassName } from './shell/shellClass'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { useWorkspaceStore } from './state/workspaceStore'
import { applyPalette } from './theme/applyPalette'
import { UpdateAvailableCard } from './updates/UpdateAvailableCard'
import { WorkspaceArea } from './workspace/WorkspaceArea'

export function App(): React.JSX.Element {
  const platform = useMemo(
    () => detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent),
    []
  )
  const modifier = useMemo(() => resolvePlatformModifier(platform), [platform])
  const isAppChord = useWorkspaceShortcuts(modifier)
  // The same commands in the menu bar, through one dispatcher over one table.
  useMenuBar()
  // What this window tells the main process about agent notices. See src/renderer/src/notices.
  useAgentNotices()

  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // Outside `dialog`: a teammate raised it, it has its own deadline, and nothing else may close it.
  const consent = useWorkspaceStore((state) => state.consent)
  const asking = firstQuestion(consent)
  const notices = useWorkspaceStore((state) => state.notices)
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice)
  const appearance = useWorkspaceStore((state) => state.appearance)

  // The one place a colour is applied. A layout effect because xterm reads the palette off this element
  // in each pane's effect, and passive effects run child-first: this write must come before those reads.
  useLayoutEffect(() => {
    applyPalette(document.documentElement, resolvePalette(appearance))
  }, [appearance])

  // One subscription for the window, started before the first read so no bootstrap-time event is missed.
  useEffect(() => {
    const stopWatching = useWorkspaceStore.getState().startWatching()
    void useWorkspaceStore.getState().bootstrap()
    return stopWatching
  }, [])

  return (
    <div
      // No title strip: on macOS the window buttons sit over the sidebar header or the pane strip, whichever
      // is at the left edge; the class list says which.
      className={shellClassName(platform, sidebarVisible)}
      style={{
        ['--sidebar-width' as string]: `${sidebarWidth}px`,
        // From src/shared/windowChrome.ts, which main also reads to place the window buttons.
        ['--titlebar-h' as string]: `${TITLEBAR_HEIGHT_PX}px`,
        ['--titlebar-inset' as string]: `${MAC_CONTENT_INSET_PX}px`
      }}
    >
      {sidebarVisible ? (
        <>
          <Sidebar searchHint={shortcutHint('open-palette', modifier)} />
          <SidebarResizer />
        </>
      ) : null}

      <WorkspaceArea modifier={modifier} isAppChord={isAppChord} />

      <StatusBar />

      {notices.length > 0 ? (
        <div className="notices" role="status" aria-live="polite">
          {notices.map((notice) => (
            <div className={`notice notice--${notice.tone}`} key={notice.id}>
              <span className="notice__text">{notice.text}</span>
              {notice.action === undefined ? null : (
                // The verb is the whole button.
                <button
                  type="button"
                  className="notice__action"
                  onClick={() => openInBrowser(notice.action?.url ?? '')}
                >
                  {notice.action.label}
                </button>
              )}
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
          whether or not anybody answers this. Both cards stand aside for
          anything modal, which now means a keystroke question as well as a
          dialog — see `modalLayer.ts`. */}
      <FirstRunCliOffer />

      {/* The same corner and the same terms: nothing focused, nothing blocked,
          and it stands aside while the first-run question is on screen. */}
      <UpdateAvailableCard />

      {dialog?.kind === 'palette' ? <CommandPalette modifier={modifier} /> : null}
      {dialog?.kind === 'confirm-remove' ? (
        <ConfirmRemoveDialog worktreeId={dialog.worktreeId} reason={dialog.reason} />
      ) : null}
      {dialog?.kind === 'confirm-close-pane' ? <ConfirmClosePaneDialog terminalId={dialog.terminalId} /> : null}
      {dialog?.kind === 'add-project' ? <AddProjectDialog /> : null}
      {dialog?.kind === 'appearance' ? <AppearanceDialog /> : null}
      {dialog?.kind === 'install-cli' ? <InstallCliDialog /> : null}
      {dialog?.kind === 'new-task' ? <TaskComposerDialog projectId={dialog.projectId} /> : null}

      {/* Last, so it is on top of whatever else is open. A question about bytes
          that are about to run as this user outranks anything this user
          themselves has half-finished. */}
      {asking ? <RemoteKeystrokesDialog request={asking} key={asking.id} /> : null}
    </div>
  )
}
