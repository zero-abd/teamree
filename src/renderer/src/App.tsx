// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useLayoutEffect, useMemo } from 'react'
import { resolvePalette } from '@shared/theme'
import { MAC_CONTENT_INSET_PX, TITLEBAR_HEIGHT_PX } from '@shared/windowChrome'
import { CloneProjectDialog } from './dialogs/CloneProjectDialog'
import { JoinTeamDialog } from './dialogs/JoinTeamDialog'
import { OpenBranchDialog } from './dialogs/OpenBranchDialog'
import { TaskComposerDialog } from './dialogs/TaskComposerDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { useMenuBar } from './menu/useMenuBar'
import { useUnsavedFiles } from './files/useUnsavedFiles'
import { useAgentNotices } from './notices/useAgentNotices'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { ConfirmCloseFileDialog } from './dialogs/ConfirmCloseFileDialog'
import { ConfirmUnsavedDialog } from './dialogs/ConfirmUnsavedDialog'
import { ConfirmDiscardDialog } from './dialogs/ConfirmDiscardDialog'
import { ConfirmClosePaneDialog } from './dialogs/ConfirmClosePaneDialog'
import { ConfirmRemoveDialog } from './dialogs/ConfirmRemoveDialog'
import { ConfirmForgetDialog } from './dialogs/ConfirmForgetDialog'
import { ConfirmTrashProjectDialog } from './dialogs/ConfirmTrashProjectDialog'
import { ConfirmMergeDialog } from './dialogs/ConfirmMergeDialog'
import { ConfirmKeepDialog } from './dialogs/ConfirmKeepDialog'
import { FirstRunCliOffer } from './dialogs/FirstRunCliOffer'
import { InstallCliDialog } from './dialogs/InstallCliDialog'
import { ProjectRefusedDialog } from './dialogs/ProjectRefusedDialog'
import { AppearanceSheet } from './settings/AppearanceSheet'
import { firstQuestion } from './dialogs/modalLayer'
import { RemoteKeystrokesDialog } from './dialogs/RemoteKeystrokesDialog'
import { CommandPalette } from './palette/CommandPalette'
import { Sidebar } from './sidebar/Sidebar'
import { openInBrowser } from './shell/openInBrowser'
import { RegionFocus } from './shell/RegionFocus'
import { shellClassName } from './shell/shellClass'
import { FolderDrop } from './shell/FolderDrop'
import { watchLayoutMotion } from './shell/layoutMotion'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { useWorkspaceStore, type Notice } from './state/workspaceStore'
import { watchSystemTone } from './theme/systemTone'
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
  useUnsavedFiles()
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
  const hideRegion = useWorkspaceStore((state) => state.hideRegion)
  const undo = useWorkspaceStore((state) => state.undo)
  const actOn = (notice: Notice): void => {
    const action = notice.action
    if (action === undefined) return
    if ('url' in action) {
      openInBrowser(action.url)
      return
    }
    dismissNotice(notice.id)
    if ('undo' in action) void undo(action.undo)
    else hideRegion(action.hide)
  }
  const appearance = useWorkspaceStore((state) => state.appearance)
  const appearanceOpen = useWorkspaceStore((state) => state.appearanceOpen)
  const systemTone = useWorkspaceStore((state) => state.systemTone)

  // The one place a colour is applied. A layout effect because xterm reads the palette off this element
  // in each pane's effect, and passive effects run child-first: this write must come before those reads.
  useLayoutEffect(() => {
    applyPalette(document.documentElement, resolvePalette(appearance, systemTone))
  }, [appearance, systemTone])

  useEffect(() => watchSystemTone(useWorkspaceStore.getState().setSystemTone), [])
  useEffect(() => watchLayoutMotion(document), [])

  // `teamree://join?…` links the OS opened the app with: the one that launched it, then each after.
  useEffect(() => {
    const links = window.teamree?.invitations
    if (links === undefined) return
    const open = (link: string): void => void useWorkspaceStore.getState().openInvitation(link, true)
    void links.take().then((link) => {
      if (link !== null) open(link)
    })
    return links.onLink(open)
  }, [])

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
      {appearanceOpen ? <AppearanceSheet /> : null}
      <RegionFocus />

      <StatusBar />

      {/* Bottom right above the status bar: notices stack above the update card, never over it. */}
      <div className="corner-stack">
        {notices.length > 0 ? (
          <div className="notices" role="status" aria-live="polite">
            {notices.map((notice) => (
              <div className={`notice notice--${notice.tone}`} key={notice.id}>
                <span className="notice__text">{notice.text}</span>
                {notice.action === undefined ? null : (
                  // The verb is the whole button.
                  <button type="button" className="notice__action" onClick={() => actOn(notice)}>
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
        <UpdateAvailableCard />
      </div>

      {/* Nothing is focused and nothing is blocked: the window is usable
          whether or not anybody answers this. It stands aside for anything
          modal, which means a keystroke question as well as a dialog. */}
      <FirstRunCliOffer />

      {dialog?.kind === 'palette' ? (
        <CommandPalette key={dialog.mode ?? 'all'} modifier={modifier} mode={dialog.mode ?? 'all'} />
      ) : null}
      {dialog?.kind === 'confirm-remove' ? <ConfirmRemoveDialog worktreeId={dialog.worktreeId} /> : null}
      {dialog?.kind === 'confirm-forget' ? <ConfirmForgetDialog target={dialog.target} /> : null}
      {dialog?.kind === 'confirm-trash-project' ? <ConfirmTrashProjectDialog projectId={dialog.projectId} /> : null}
      {dialog?.kind === 'confirm-merge' ? <ConfirmMergeDialog worktreeId={dialog.worktreeId} /> : null}
      {dialog?.kind === 'confirm-keep' ? <ConfirmKeepDialog worktreeId={dialog.worktreeId} /> : null}
      {dialog?.kind === 'confirm-close-pane' ? <ConfirmClosePaneDialog terminalId={dialog.terminalId} /> : null}
      {dialog?.kind === 'confirm-close-file' ? <ConfirmCloseFileDialog terminalId={dialog.terminalId} /> : null}
      {dialog?.kind === 'confirm-unsaved' ? <ConfirmUnsavedDialog paneIds={dialog.paneIds} /> : null}
      {dialog?.kind === 'confirm-discard' ? (
        <ConfirmDiscardDialog
          worktreeId={dialog.worktreeId}
          path={dialog.path}
          {...(dialog.hunk ? { hunk: dialog.hunk } : {})}
        />
      ) : null}
      {dialog?.kind === 'project-refused' ? (
        <ProjectRefusedDialog folder={dialog.folder} refusal={dialog.refusal} />
      ) : null}
      {dialog?.kind === 'clone-project' ? <CloneProjectDialog /> : null}
      {dialog?.kind === 'install-cli' ? <InstallCliDialog /> : null}
      {dialog?.kind === 'new-task' ? <TaskComposerDialog projectId={dialog.projectId} /> : null}
      {dialog?.kind === 'join-team' ? <JoinTeamDialog invitation={dialog.invitation} /> : null}
      {dialog?.kind === 'open-branch' ? (
        <OpenBranchDialog projectId={dialog.projectId} pullRequests={dialog.pullRequests === true} />
      ) : null}

      {/* Last, so it is on top of whatever else is open. A question about bytes
          that are about to run as this user outranks anything this user
          themselves has half-finished. */}
      {asking ? <RemoteKeystrokesDialog request={asking} key={asking.id} /> : null}
      {/* A folder dropped anywhere on the window becomes a project. */}
      <FolderDrop />
    </div>
  )
}
