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
  // And the same commands in the menu bar, which is the other half of the same
  // thing: the chord and the menu item run one dispatcher over one table, so
  // neither can offer what the other refuses. See src/renderer/src/menu.
  useMenuBar()
  // And the only other thing this window says about itself to the process
  // outside it: what it wants an agent going quiet to do, and which pane it is
  // already looking at. See src/renderer/src/notices.
  useAgentNotices()

  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // Somebody else's keystrokes, waiting on this machine's owner. Read outside
  // `dialog` because it is not this window's own action: a teammate raised it,
  // it has a deadline of its own, and it must not be closed by opening
  // something else or cleared by whatever the user was in the middle of.
  const consent = useWorkspaceStore((state) => state.consent)
  const asking = firstQuestion(consent)
  const notices = useWorkspaceStore((state) => state.notices)
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice)
  const appearance = useWorkspaceStore((state) => state.appearance)

  // The one place a colour is applied. `tokens.css` has already painted the
  // window in the default palette by the time this runs, so the common case —
  // the default theme, unedited — writes the same values back and nothing
  // flickers; anything else takes over here, before the first frame anybody
  // looks at.
  //
  // A layout effect, and that is not about avoiding a flash of the old colours
  // — it is about the panes. Every emulator re-reads the palette off this
  // element in an effect of its own, because xterm cannot read CSS, and React
  // flushes effects child-first: an ordinary `useEffect` here would run *after*
  // every pane's, so each pane would read the palette this component had not
  // written yet and repaint itself in the theme before last. Layout effects all
  // run before any passive one, which puts the write back in front of the reads
  // it exists for. See `terminalTheme.ts` and the two views that call it.
  useLayoutEffect(() => {
    applyPalette(document.documentElement, resolvePalette(appearance))
  }, [appearance])

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
      // There is no title strip. The window's top edge is the sidebar's own
      // header on the left and the pane strip on the right, and on macOS the
      // window buttons sit over whichever of the two is at the left edge —
      // the class list says which, and the stylesheet moves the inset.
      className={shellClassName(platform, sidebarVisible)}
      style={{
        ['--sidebar-width' as string]: `${sidebarWidth}px`,
        // Both come from src/shared/windowChrome.ts, which the main process also
        // reads to place the macOS window buttons.
        ['--titlebar-h' as string]: `${TITLEBAR_HEIGHT_PX}px`,
        ['--titlebar-inset' as string]: `${MAC_CONTENT_INSET_PX}px`
      }}
    >
      {sidebarVisible ? (
        <>
          <Sidebar
            newWorktreeHint={shortcutHint('new-worktree', modifier)}
            searchHint={shortcutHint('open-palette', modifier)}
          />
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
              {notice.action === undefined ? null : (
                // The verb is the whole button. What it would open is in the
                // sentence beside it, and a notice is not the place for a
                // second sentence explaining the first.
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
