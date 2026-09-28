// App shell: sidebar, workspace, status bar — plus the two things that have to
// live above all of them, the key map and the modal layer.

import { useEffect, useLayoutEffect, useMemo } from 'react'
import { resolvePalette } from '@shared/theme'
import { MAC_CONTENT_INSET_PX, TITLEBAR_HEIGHT_PX } from '@shared/windowChrome'
import { CloneProjectDialog } from './dialogs/CloneProjectDialog'
import { JoinInvitationDialog } from './dialogs/JoinInvitationDialog'
import { JoinTeamDialog } from './dialogs/JoinTeamDialog'
import { OpenBranchDialog } from './dialogs/OpenBranchDialog'
import { ResumeConversationDialog } from './dialogs/ResumeConversationDialog'
import { TaskComposerDialog } from './dialogs/TaskComposerDialog'
import { detectPlatform, resolvePlatformModifier } from './keyboard/platformModifier'
import { useWorkspaceShortcuts } from './keyboard/useWorkspaceShortcuts'
import { useMenuBar } from './menu/useMenuBar'
import { useUnsavedFiles } from './files/useUnsavedFiles'
import { useAgentNotices } from './notices/useAgentNotices'
import { NoticeStack } from './notices/NoticeStack'
import { usePullRequestRefresh } from './state/usePullRequestRefresh'
import { RegionBoundary } from './errors/RegionBoundary'
import { useMainErrors } from './errors/useMainErrors'
import { useScrollbackLines } from './terminal/scrollbackLines'
import { shortcutHint } from './keyboard/workspaceShortcuts'
import { ConfirmCloseFileDialog } from './dialogs/ConfirmCloseFileDialog'
import { ConfirmUnsavedDialog } from './dialogs/ConfirmUnsavedDialog'
import { ConfirmDiscardDialog } from './dialogs/ConfirmDiscardDialog'
import { ConfirmClosePaneDialog } from './dialogs/ConfirmClosePaneDialog'
import { ConfirmRemoveDialog } from './dialogs/ConfirmRemoveDialog'
import { ConfirmForgetDialog } from './dialogs/ConfirmForgetDialog'
import { ConfirmTrashProjectDialog } from './dialogs/ConfirmTrashProjectDialog'
import { ConfirmMergeDialog } from './dialogs/ConfirmMergeDialog'
import { CreatePullRequestDialog } from './dialogs/CreatePullRequestDialog'
import { PushBaseDialog } from './dialogs/PushBaseDialog'
import { ConfirmCleanUpDialog } from './dialogs/ConfirmCleanUpDialog'
import { ConfirmKeepDialog } from './dialogs/ConfirmKeepDialog'
import { ClearLockDialog } from './dialogs/ClearLockDialog'
import { CommitOutputSheet } from './workspace/rightPanel/CommitBlocked'
import { ConfirmRebaseDialog } from './dialogs/ConfirmRebaseDialog'
import { MoveUnderDialog } from './dialogs/MoveUnderDialog'
import { HandOffDialog } from './dialogs/HandOffDialog'
import { FirstRunCliOffer } from './dialogs/FirstRunCliOffer'
import { SetupDialog } from './workspace/SetupDialog'
import { InstallCliDialog } from './dialogs/InstallCliDialog'
import { DecisionsDialog } from './dialogs/DecisionsDialog'
import { PortsDialog } from './dialogs/PortsDialog'
import { ProjectRefusedDialog } from './dialogs/ProjectRefusedDialog'
import { AppearanceSheet } from './settings/AppearanceSheet'
import { firstQuestion } from './dialogs/modalLayer'
import { RemoteKeystrokesDialog } from './dialogs/RemoteKeystrokesDialog'
import { CommandPalette } from './palette/CommandPalette'
import { Sidebar } from './sidebar/Sidebar'
import { RegionFocus } from './shell/RegionFocus'
import { shellClassName } from './shell/shellClass'
import { FolderDrop } from './shell/FolderDrop'
import { watchLayoutMotion } from './shell/layoutMotion'
import { SidebarResizer } from './shell/SidebarResizer'
import { StatusBar } from './shell/StatusBar'
import { useWorkspaceStore } from './state/workspaceStore'
import { watchSystemTone } from './theme/systemTone'
import { applyPalette } from './theme/applyPalette'
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
  usePullRequestRefresh()
  useMainErrors()
  useScrollbackLines()

  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  // Settings brings its own section list, so it has the window to itself; the sidebar comes back as it was.
  const settingsShown = useWorkspaceStore(
    (state) => state.settingsOpen && !state.dashboardOpen && state.teamworkProjectId === null
  )
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible) && !settingsShown
  const dialog = useWorkspaceStore((state) => state.dialog)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  // Outside `dialog`: a teammate raised it, it has its own deadline, and nothing else may close it.
  const consent = useWorkspaceStore((state) => state.consent)
  const asking = firstQuestion(consent)
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
          <RegionBoundary region="sidebar">
            <Sidebar searchHint={shortcutHint('open-palette', modifier)} />
          </RegionBoundary>
          <SidebarResizer />
        </>
      ) : null}

      <RegionBoundary region="workspace">
        <WorkspaceArea modifier={modifier} isAppChord={isAppChord} />
      </RegionBoundary>
      {appearanceOpen ? <AppearanceSheet /> : null}
      <RegionFocus />

      <StatusBar />

      <NoticeStack />

      {/* Nothing is focused and nothing is blocked: the window is usable
          whether or not anybody answers this. It stands aside for anything
          modal, which means a keystroke question as well as a dialog. */}
      <FirstRunCliOffer />

      <RegionBoundary region="dialog" resetKey={dialog?.kind ?? ''} onDismiss={closeDialog}>
        {dialog?.kind === 'palette' ? (
          <CommandPalette
            key={dialog.mode ?? 'all'}
            modifier={modifier}
            mode={dialog.mode ?? 'all'}
            {...(dialog.query === undefined ? {} : { query: dialog.query })}
          />
        ) : null}
        {dialog?.kind === 'confirm-remove' ? <ConfirmRemoveDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'confirm-forget' ? <ConfirmForgetDialog target={dialog.target} /> : null}
        {dialog?.kind === 'confirm-trash-project' ? <ConfirmTrashProjectDialog projectId={dialog.projectId} /> : null}
        {dialog?.kind === 'confirm-merge' ? <ConfirmMergeDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'create-pr' ? <CreatePullRequestDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'push-base' ? <PushBaseDialog key={dialog.projectId} projectId={dialog.projectId} /> : null}
        {dialog?.kind === 'confirm-keep' ? <ConfirmKeepDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'move-under' ? <MoveUnderDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'hand-off' ? <HandOffDialog worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'confirm-rebase' ? (
          <ConfirmRebaseDialog worktreeId={dialog.worktreeId} parentId={dialog.parentId} />
        ) : null}
        {dialog?.kind === 'clean-up' ? <ConfirmCleanUpDialog projectId={dialog.projectId} /> : null}
        {dialog?.kind === 'confirm-close-pane' ? <ConfirmClosePaneDialog terminalId={dialog.terminalId} /> : null}
        {dialog?.kind === 'confirm-close-file' ? <ConfirmCloseFileDialog terminalId={dialog.terminalId} /> : null}
        {dialog?.kind === 'confirm-unsaved' ? <ConfirmUnsavedDialog paneIds={dialog.paneIds} /> : null}
        {dialog?.kind === 'clear-lock' ? (
          <ClearLockDialog worktreeId={dialog.worktreeId} lockPath={dialog.lockPath} />
        ) : null}
        {dialog?.kind === 'commit-output' ? <CommitOutputSheet worktreeId={dialog.worktreeId} /> : null}
        {dialog?.kind === 'confirm-discard' ? (
          <ConfirmDiscardDialog
            worktreeId={dialog.worktreeId}
            path={dialog.path}
            {...(dialog.hunk ? { hunk: dialog.hunk } : {})}
            {...(dialog.paths ? { paths: dialog.paths } : {})}
          />
        ) : null}
        {dialog?.kind === 'project-refused' ? (
          <ProjectRefusedDialog folder={dialog.folder} refusal={dialog.refusal} />
        ) : null}
        {dialog?.kind === 'clone-project' ? <CloneProjectDialog /> : null}
        {dialog?.kind === 'install-cli' ? <InstallCliDialog /> : null}
        {dialog?.kind === 'decisions' ? <DecisionsDialog projectId={dialog.projectId} /> : null}
        {dialog?.kind === 'ports' ? <PortsDialog /> : null}
        {dialog?.kind === 'setup' ? <SetupDialog /> : null}
        {dialog?.kind === 'new-task' ? (
          <TaskComposerDialog
            projectId={dialog.projectId}
            {...(dialog.parentId === undefined ? {} : { parentId: dialog.parentId })}
            fromIssue={dialog.fromIssue === true}
            {...(dialog.task === undefined ? {} : { task: dialog.task })}
          />
        ) : null}
        {dialog?.kind === 'join-invitation' ? <JoinInvitationDialog /> : null}
        {dialog?.kind === 'join-team' ? <JoinTeamDialog invitation={dialog.invitation} /> : null}
        {dialog?.kind === 'open-branch' ? (
          <OpenBranchDialog
            projectId={dialog.projectId}
            pullRequests={dialog.pullRequests === true}
            {...(dialog.query === undefined ? {} : { query: dialog.query })}
          />
        ) : null}
        {dialog?.kind === 'resume-conversation' ? (
          <ResumeConversationDialog
            worktreeId={dialog.worktreeId}
            {...(dialog.terminalId === undefined ? {} : { terminalId: dialog.terminalId })}
          />
        ) : null}
      </RegionBoundary>

      {/* Last, so it is on top of whatever else is open. A question about bytes
          that are about to run as this user outranks anything this user
          themselves has half-finished. */}
      {asking ? <RemoteKeystrokesDialog request={asking} key={asking.id} /> : null}
      {/* A folder dropped anywhere on the window becomes a project. */}
      <FolderDrop />
    </div>
  )
}
