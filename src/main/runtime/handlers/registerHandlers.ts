// The handler seam: the one place feature areas are wired into the runtime.
// A later registration replaces an earlier one, which is how a real handler
// takes over from its placeholder; areas that mutate state also publish events.

import { dirname } from 'node:path'
import type { MethodRegistry } from '../methodRegistry'
import { CliService, createAdministratorRunner, findShippedCli, registerCliHandlers } from '../../cli'
import { createEditorActions, registerEditorHandlers } from '../../editor'
import { registerFileHandlers } from '../../files'
import { GitService, registerGitHandlers } from '../../git'
import { startSetupCommand } from '../../git/worktreeSetup'
import { degradedTeamreeWatchReport, registerTeamworkHandlers, TeamreeWatcher, TeamworkService } from '../../teamwork'
import { PeerService, registerPeerHandlers } from '../../teamwork/peer'
import { createTerminalService, registerTerminalHandlers } from '../../terminals/method-handlers'
import { UpdateService, registerUpdateHandlers } from '../../updates'
import type { TerminalService } from '../../terminals/method-handlers'
import type { ScrollbackRepository } from '../../terminals/session-manager'
import type { AgentNotice } from '../../agentNotices'
import type { Appearance } from '../../../shared/theme'
import { registerAppearanceHandlers } from './appearanceHandlers'
import { registerPlaceholderHandlers } from './placeholderHandlers'
import { registerQuitHandler } from './quitHandler'
import { registerResourcesHandlers } from './resourcesHandlers'
import { registerStatusHandler } from './statusHandler'
import { registerUnsubscribeHandler } from './unsubscribeHandler'
import { registerWorkspaceSubscribeHandler } from './workspaceSubscribeHandler'
import {
  publishGitEvents,
  publishGitWrites,
  publishTerminalEvents,
  publishWorktreeFileEvents
} from '../workspaceEventSources'

/** Areas that own live OS resources and must be torn down when the app quits. */
export type RegisteredAreas = {
  terminals: TerminalService
  git: GitService
  /** Filesystem watches behind live git status. Released when the app quits. */
  worktreeFiles: { close: () => void }
  /** Watches on each project's `.teamree`, so a teammate's key arriving in a pull needs no restart. */
  teamworkFiles: { close: () => void }
  /** Outbound relay connections, one per teammate. Started after the dispatcher exists. */
  peers: PeerService
  /** The update check: one timer, and quitting must never be waiting on GitHub. */
  updates: UpdateService
}

export type RegisterHandlersOptions = {
  /** Opens a URL in the user's browser. Absent with no Electron around, where the download call refuses. */
  openExternal?: (url: string) => Promise<void>
  /** Where the update's `.dmg` is saved. Absent with no Electron around, where fetching it refuses. */
  downloadsDirectory?: string
  /** `shell.openPath`: opens the fetched `.dmg`. Absent with no Electron around. */
  openPath?: (path: string) => Promise<string>
  /** `shell.trashItem`, for discarding an untracked file. Absent with no Electron around, where that refuses. */
  trashItem?: (path: string) => Promise<void>
  /** Where each pane's output is kept between launches. Absent, panes come back with nothing above their prompt. */
  scrollback?: ScrollbackRepository
  /**
   * Parent of every checkout. Absent, `~/.teamree/worktrees` stands; see
   * `RuntimeOptions` in startRuntime.ts for why a harness must set it.
   */
  worktreesRoot?: string
  /** Announces an agent pane that has stopped (an OS notification in the app). Absent with no window around. */
  onAgentNotice?: (notice: AgentNotice) => void
  /**
   * Ends the app: `app.quit()` and nothing else, the one ending that runs
   * `before-quit`, where the ptys are killed and awaited. Absent, the method refuses.
   */
  requestQuit?: (force: boolean) => void
  unsavedFiles?: () => readonly string[]
  /** Hears each stored appearance. Absent with no window around. */
  onAppearance?: (appearance: Appearance) => void
}

export function registerHandlers(registry: MethodRegistry, options: RegisterHandlersOptions = {}): RegisteredAreas {
  registerPlaceholderHandlers(registry)
  registerStatusHandler(registry)
  registerQuitHandler(registry, {
    ...(options.requestQuit === undefined ? {} : { requestQuit: options.requestQuit }),
    ...(options.unsavedFiles === undefined ? {} : { unsavedFiles: options.unsavedFiles })
  })
  registerUnsubscribeHandler(registry)
  registerWorkspaceSubscribeHandler(registry)
  registerAppearanceHandlers(registry, options.onAppearance)
  // One file of a worktree at a time, for a file pane.
  registerFileHandlers(registry)
  const workspaceEvents = registry.context.workspaceEvents

  // The private key belongs beside the workspace file, never under a repository.
  const dataDir = dirname(registry.context.store.filePath)
  // Found once: the installer links it onto PATH and every agent pane's hooks run it.
  const shippedCli = findShippedCli({ resourcesPath: process.resourcesPath })

  const terminals = createTerminalService({
    subscriptions: registry.context.subscriptions,
    resolveWorktreeCwd: (worktreeId) => registry.context.store.getWorktree(worktreeId)?.path,
    resolveWorktreeTask: (worktreeId) => registry.context.store.getWorktree(worktreeId)?.task,
    layouts: registry.context.store,
    sessions: registry.context.store,
    // Beside the workspace file rather than in it; `scrollbackArchive.ts` says why.
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
    // Agent hooks report the agent's state through this app's CLI; without one
    // the pane is read off the pty alone.
    ...(shippedCli === null ? {} : { agentHooks: { userDataDir: dataDir, cli: shippedCli.path } }),
    // Two events per burst of work, not one per chunk of output.
    onActivityChange: () => workspaceEvents.emit({ type: 'terminals' }),
    // The worktree's *name* is attached here because only the store knows it;
    // a pane whose worktree is already removed is dropped for the same reason.
    ...(options.onAgentNotice === undefined
      ? {}
      : {
          onAgentSettled: (settled) => {
            const worktree = registry.context.store.getWorktree(settled.worktreeId)
            if (!worktree) return
            options.onAgentNotice?.({
              terminalId: settled.terminalId,
              worktreeId: settled.worktreeId,
              worktree: worktree.name,
              reason: settled.reason,
              line: settled.line
            })
          }
        })
  })
  // Terminals first: recorded panes come back under their ids, agent panes with
  // their conversation resumed.
  terminals.restoreSessions()
  // Then the layouts, for whatever did not come back; otherwise the UI renders
  // panes bound to dead ids.
  terminals.reconcileLayouts()
  registerTerminalHandlers(registry, terminals)
  // Wraps the handlers just registered so every change reaches the workspace stream.
  publishTerminalEvents(registry, terminals, workspaceEvents)
  // Not a terminal method: the app's own processes are on the answer too.
  registerResourcesHandlers(registry, { panes: () => terminals.manager.paneProcesses() })

  const git = new GitService({
    store: registry.context.store,
    // Spread rather than passed as `undefined`, so the service's own default stands.
    ...(options.worktreesRoot === undefined ? {} : { worktreesRoot: options.worktreesRoot }),
    ...(options.trashItem === undefined ? {} : { trash: options.trashItem }),
    // The one seam between "a checkout is ready" and "a pane is open in it",
    // for a GUI create and a CLI create alike.
    startSetup: ({ worktree, command }) => {
      const terminal = startSetupCommand(terminals.manager, { worktreeId: worktree.id, command })
      // Announced by hand: the pane was not opened by `terminal.create`, so the
      // wrapper in workspaceEventSources.ts never runs.
      workspaceEvents.emit({ type: 'terminals' })
      workspaceEvents.emit({ type: 'layout', worktreeId: terminal.worktreeId })
      return terminal.id
    }
  })
  // A removed worktree takes its panes with it; nothing else drops a terminal
  // record, so without this the agents keep running in a directory that is gone.
  git.events.on((event) => {
    if (event.type !== 'worktree.removed') return
    void closeWorktreeTerminals(terminals, event.worktreeId)
      .then(() => {
        // Closing the last pane saves the layout, which would put back the record just deleted.
        registry.context.store.removeLayout(event.worktreeId)
        // The panes that left were not closed by any client's call.
        workspaceEvents.emit({ type: 'terminals' })
      })
      .catch((error: unknown) => console.error('[terminals]', error))
  })
  // A create interrupted by a quit can never resume, so it is marked failed and
  // offered as a retry rather than left stuck in `creating`.
  git.reviveRestoredRecords()
  registerGitHandlers(registry, git)
  // Git transitions a worktree on a background task long after the call returned.
  publishGitEvents(git, workspaceEvents)
  // Committing and pushing change what status answers without moving any record.
  publishGitWrites(registry, git, workspaceEvents)
  // Git status has no call behind it; file changes are what keep it honest.
  const worktreeFiles = publishWorktreeFileEvents(git, workspaceEvents)

  // A pull that brings in a teammate's key or the team's relay is nobody's
  // method call; without this both machines sit on the roster read before it.
  const teamworkWatcher = new TeamreeWatcher({
    onChange: () => workspaceEvents.emit({ type: 'members' }),
    onDegraded: (event) => console.warn(`[teamwork] ${degradedTeamreeWatchReport(event)}`)
  })
  teamworkWatcher.sync(registry.context.store.listProjects())

  registerTeamworkHandlers(
    registry,
    new TeamworkService({
      store: registry.context.store,
      dataDir,
      // So a roster read can say whether it will stay true by itself.
      watching: (projectId) => teamworkWatcher.watches(projectId),
      // The watch above can be degraded, so the service's own `.teamree` writes say so themselves.
      onRosterChange: () => workspaceEvents.emit({ type: 'members' })
    })
  )

  // The privileged runner is handed over here so the only code that can reach
  // osascript is code that asked for it.
  registerCliHandlers(
    registry,
    new CliService({
      source: shippedCli?.path ?? null,
      packaged: shippedCli?.packaged ?? false,
      administrator: createAdministratorRunner(),
      // Asked once and never again; the workspace file gains one field.
      prompt: {
        askedAt: () => registry.context.store.askedAt('installCli'),
        markAsked: (at) => registry.context.store.markAsked('installCli', at)
      }
    })
  )

  // Nothing to tear down: an editor teamree started is not its child, and
  // quitting must not close the window somebody is working in.
  registerEditorHandlers(registry, createEditorActions())

  // One timer; nothing reaches the network until `start()`, which the runtime
  // calls well after a window is up.
  const updates = registerUpdateHandlers(
    registry,
    new UpdateService({
      version: registry.context.version,
      settings: {
        read: () => registry.context.store.updateSettings(),
        setAutomatic: (automatic) => registry.context.store.setUpdateAutomatic(automatic),
        recordAttempt: (at) => registry.context.store.recordUpdateCheck(at),
        rememberLatest: (version) => registry.context.store.rememberLatestVersion(version)
      },
      openExternal: options.openExternal,
      downloadsDirectory: options.downloadsDirectory,
      openPath: options.openPath,
      // A window hears about a check it did not start the way it hears about a
      // worktree the CLI made.
      onChange: () => workspaceEvents.emit({ type: 'updates' })
    })
  )

  const peers = registerPeerHandlers(
    registry,
    new PeerService({
      workspace: {
        listProjects: () => registry.context.store.listProjects(),
        listWorktrees: (projectId) => registry.context.store.listWorktrees(projectId),
        listTerminals: (worktreeId) => terminals.manager.list(worktreeId)
      },
      dataDir,
      subscriptions: registry.context.subscriptions,
      // Kept beside the terminal records, so a restored pane comes back as muted as it was left.
      mutes: {
        list: () => registry.context.store.listMutedTerminals(),
        set: (terminalId, muted) => registry.context.store.setTerminalMuted(terminalId, muted)
      },
      // Same file for the same reason.
      consent: {
        list: () => registry.context.store.listStandingConsent(),
        set: (terminalId, publicKey, since) => registry.context.store.setStandingConsent(terminalId, publicKey, since)
      },
      onChange: () => workspaceEvents.emit({ type: 'teammates' }),
      // Nothing a peer does may fail quietly: none of it stops the app, and
      // without this none of it leaves a trace either.
      onError: (error) => console.error('[teamwork]', error)
    })
  )
  // A teammate's view of this machine rides the same bus everything else does.
  workspaceEvents.on((event) => {
    // `teammates` is this service's own event; fed back in, a link changing
    // phase would cost every peer a fresh snapshot of a workspace that did not move.
    if (event.type === 'teammates') return
    // A project added or removed changes which checkouts are watched.
    if (event.type === 'projects') teamworkWatcher.sync(registry.context.store.listProjects())
    // A reconcile that throws after the project facts are in place leaves full
    // rosters with no links; silence here was a lie on screen.
    if (event.type === 'projects' || event.type === 'members') {
      void peers.reconcile().catch((error: unknown) => console.error('[teamwork]', error))
    }
    peers.notifyWorkspaceChanged()
  })

  return { terminals, git, worktreeFiles, teamworkFiles: teamworkWatcher, peers, updates }
}

/**
 * Closes every pane of a removed worktree. The checkout is already gone, so
 * nothing here may depend on the directory. One at a time, because each close
 * rewrites the same layout; each on its own, so one stuck pane does not keep the rest alive.
 */
async function closeWorktreeTerminals(terminals: TerminalService, worktreeId: string): Promise<void> {
  for (const terminal of terminals.manager.list(worktreeId)) {
    try {
      await terminals.manager.close(terminal.id)
    } catch (error) {
      console.error(`[terminals] could not close ${terminal.id} of removed worktree ${worktreeId}`, error)
    }
  }
}
