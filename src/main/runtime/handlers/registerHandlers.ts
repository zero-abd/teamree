// THE HANDLER SEAM.
//
// `registerHandlers(registry)` is the one place feature areas are wired into the
// runtime. To add an area: write `handlers/<area>Handlers.ts` exporting
// `register<Area>Handlers(registry: MethodRegistry): void`, and add one call
// below, after the placeholders.
//
// Inside your module call `registry.register(method, schema, handler)` with the
// schema from `Params` in src/shared/methods.ts. Registration order matters only
// in that a later registration replaces an earlier one, which is how a real
// handler takes over from its placeholder. Handlers get `(params, call)`:
// `params` is already validated, `call.connectionId` identifies the caller and is
// the key for `registry.context.subscriptions`. Process-wide dependencies —
// version, endpoint, the workspace store, the subscription hub — hang off
// `registry.context`. Throw `RuntimeError` (see runtimeError.ts) for anything the
// caller should see as a structured error code; any other throw becomes
// `internal`.
//
// An area that changes workspace state also belongs on the change stream: after
// registering it, publish its changes onto `registry.context.workspaceEvents`
// (see workspaceEventSources.ts). Publishing at the service, not at a transport,
// is what lets a GUI subscriber see a mutation the CLI made.

import { dirname } from 'node:path'
import type { MethodRegistry } from '../methodRegistry'
import { CliService, createAdministratorRunner, findShippedCli, registerCliHandlers } from '../../cli'
import { GitService, registerGitHandlers } from '../../git'
import { degradedTeamreeWatchReport, registerTeamworkHandlers, TeamreeWatcher, TeamworkService } from '../../teamwork'
import { PeerService, registerPeerHandlers } from '../../teamwork/peer'
import { createTerminalService, registerTerminalHandlers } from '../../terminals/method-handlers'
import { UpdateService, registerUpdateHandlers } from '../../updates'
import type { TerminalService } from '../../terminals/method-handlers'
import type { ScrollbackRepository } from '../../terminals/session-manager'
import type { AgentNotice } from '../../agentNotices'
import { registerAppearanceHandlers } from './appearanceHandlers'
import { registerPlaceholderHandlers } from './placeholderHandlers'
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
  /**
   * Filesystem watches on each project's `.teamree`, which is what makes a
   * teammate's key arriving in a pull reach the app without a restart.
   */
  teamworkFiles: { close: () => void }
  /**
   * Outbound relay connections, one per teammate. Started after the dispatcher
   * exists, because a peer that reached a half-built registry would be told a
   * method does not exist when it merely does not exist yet.
   */
  peers: PeerService
  /**
   * The update check. It owns one timer and nothing else, which is the whole
   * reason it is on this list: quitting must never be waiting on GitHub.
   */
  updates: UpdateService
}

export type RegisterHandlersOptions = {
  /**
   * Opens a URL in the user's browser. Absent in a runtime with no Electron
   * around it — the acceptance host, a vitest worker — where the update check's
   * download call then refuses rather than pretending to have opened something.
   */
  openExternal?: (url: string) => Promise<void>
  /**
   * Where each pane's output is kept between launches. Opened by the runtime
   * rather than here because opening it reads a directory, and this function is
   * the synchronous assembly of a registry. Absent, panes still come back — with
   * nothing above their prompt.
   */
  scrollback?: ScrollbackRepository
  /**
   * Parent of every checkout the git service creates. Absent, the git service's
   * own default — `~/.teamree/worktrees` — stands, which is what the app wants
   * and what every harness with a temporary home does not. See `RuntimeOptions`
   * in startRuntime.ts for why isolating the store is not enough.
   */
  worktreesRoot?: string
  /**
   * Announces an agent pane that has stopped, which in the app is an OS
   * notification. Absent in every runtime with no window around it — the
   * acceptance host, a vitest worker — where nothing has anywhere to raise one.
   */
  onAgentNotice?: (notice: AgentNotice) => void
}

export function registerHandlers(registry: MethodRegistry, options: RegisterHandlersOptions = {}): RegisteredAreas {
  registerPlaceholderHandlers(registry)
  registerStatusHandler(registry)
  registerUnsubscribeHandler(registry)
  registerWorkspaceSubscribeHandler(registry)
  // Two reads and a write against the store, with no resource behind them.
  registerAppearanceHandlers(registry)
  const workspaceEvents = registry.context.workspaceEvents

  const terminals = createTerminalService({
    subscriptions: registry.context.subscriptions,
    // Terminals open in their worktree's checkout, so the store is the authority
    // on where that is.
    resolveWorktreeCwd: (worktreeId) => registry.context.store.getWorktree(worktreeId)?.path,
    layouts: registry.context.store,
    sessions: registry.context.store,
    // Beside the workspace file rather than in it: a pane's description belongs
    // in the file this app must be able to read, and a pane's transcript is
    // orders of magnitude larger, rewritten constantly, and worth nothing if it
    // is lost. `scrollbackArchive.ts` makes the argument in full.
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
    // A pane going busy or quiet is the only thing this app knows about what an
    // agent is doing, and it is what the sidebar reads. Two events per burst of
    // work, not one per chunk of output.
    onActivityChange: () => workspaceEvents.emit({ type: 'terminals' }),
    // And the half of that worth leaving the window for. The worktree's *name*
    // is attached here rather than by whoever raises the notification, because
    // the store is the only thing that knows it and the notifier has no
    // business asking a workspace anything: a notification titled with a
    // worktree id would be addressed to nobody. A pane whose worktree has
    // already been removed is dropped for the same reason.
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
  // Terminals first: each recorded one comes back under the id its panes
  // already name, an agent pane comes back with its conversation resumed, and
  // every other one comes back showing what it printed before the app quit,
  // under a line saying that is what it is.
  terminals.restoreSessions()
  // Then the layouts, for whatever did not come back — a worktree deleted while
  // the app was closed, a shell that no longer exists. Without this the UI
  // renders panes bound to dead ids.
  terminals.reconcileLayouts()
  registerTerminalHandlers(registry, terminals)
  // Wraps the handlers just registered, so every terminal and layout change
  // reaches the workspace stream whichever transport asked for it.
  publishTerminalEvents(registry, terminals, workspaceEvents)

  const git = new GitService({
    store: registry.context.store,
    // Spread rather than passed as `undefined`, because `undefined` is a value
    // the option reader would have to know to ignore; an absent key is the
    // default, said once, in the service that owns it.
    ...(options.worktreesRoot === undefined ? {} : { worktreesRoot: options.worktreesRoot })
  })
  // A worktree removed takes its panes with it, and nothing else does this: a
  // terminal record is dropped only by an explicit close, so without this the
  // agents that were running in the checkout keep running — in a directory
  // that is gone, invisible to the sidebar and the dashboard alike, and still
  // counted by the status bar.
  git.events.on((event) => {
    if (event.type !== 'worktree.removed') return
    void closeWorktreeTerminals(terminals, event.worktreeId)
      .then(() => {
        // Closing the last pane saves the worktree's layout, which would put
        // back the record the removal just deleted.
        registry.context.store.removeLayout(event.worktreeId)
        // The list every client holds is shorter now, and the panes that left
        // it were not closed by any call of theirs.
        workspaceEvents.emit({ type: 'terminals' })
      })
      .catch((error: unknown) => console.error('[terminals]', error))
  })
  // A create interrupted by a quit can never resume, so it is marked failed and
  // offered as a retry rather than left stuck in `creating`.
  git.reviveRestoredRecords()
  registerGitHandlers(registry, git)
  // Git transitions a worktree on a background task long after the call
  // returned, so its own emitter is the only honest source for those.
  publishGitEvents(git, workspaceEvents)
  // Committing and pushing change what status answers without moving any
  // record, so they have to say so themselves.
  publishGitWrites(registry, git, workspaceEvents)
  // Git status has no call behind it, so file changes are the only thing that
  // can keep it honest between one command and the next.
  const worktreeFiles = publishWorktreeFileEvents(git, workspaceEvents)

  // The private key belongs beside the workspace file, in the app's own data
  // directory, and never anywhere under a repository. That directory is not on
  // the runtime context, but the store's path is exactly it plus a file name,
  // and the store is already the authority on where this app keeps things.
  const dataDir = dirname(registry.context.store.filePath)

  // `.teamree` lives in the primary checkout, and a pull that brings in a
  // teammate's key or the team's relay is nobody's method call. Without this
  // both machines sit on the roster they read before the pull, and the runbook
  // had to tell people to quit the app and open it again.
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
      // So a roster read can say whether it will stay true by itself, rather
      // than letting a list nothing is following look as live as one that is.
      watching: (projectId) => teamworkWatcher.watches(projectId),
      // Writing a member file or a relay is this app's own change to `.teamree`,
      // and the watch above can be degraded, so the service says so itself.
      onRosterChange: () => workspaceEvents.emit({ type: 'members' })
    })
  )

  // Nothing to tear down and nothing to watch: putting the CLI on PATH is two
  // reads and, at most, one symlink. The privileged runner is handed over here
  // rather than defaulted inside the service, so that the only code that can
  // reach osascript is code that asked for it.
  const shippedCli = findShippedCli({ resourcesPath: process.resourcesPath })
  registerCliHandlers(
    registry,
    new CliService({
      source: shippedCli?.path ?? null,
      packaged: shippedCli?.packaged ?? false,
      administrator: createAdministratorRunner(),
      // The offer made on first run is asked once and never again, so the
      // answer goes where the rest of this installation's state already
      // lives. Nothing new on disk: the workspace file gains one field.
      prompt: {
        askedAt: () => registry.context.store.askedAt('installCli'),
        markAsked: (at) => registry.context.store.markAsked('installCli', at)
      }
    })
  )

  // One timer and no other resource, and nothing here reaches the network until
  // it fires — `start()` is the runtime's to call, well after a window is up.
  // The preference and the rate limit's clock go in the workspace file beside
  // the CLI question's answer: that is where this installation's own state
  // already lives, and one boolean does not earn a second file.
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
      // A window hears about a check it did not start — the one half a minute
      // after launch, and the one behind the macOS app menu — the same way it
      // hears about a worktree the CLI made: the runtime says something moved
      // and the client re-reads it.
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
      // The owner's mutes, kept beside the terminal records they are about, so
      // a pane restored under the id it had comes back as muted as it was left.
      mutes: {
        list: () => registry.context.store.listMutedTerminals(),
        set: (terminalId, muted) => registry.context.store.setTerminalMuted(terminalId, muted)
      },
      // And the permissions, kept in the same file for the same reason: the
      // owner decided once, about a pane that comes back under the id it had.
      consent: {
        list: () => registry.context.store.listStandingConsent(),
        set: (terminalId, publicKey, since) => registry.context.store.setStandingConsent(terminalId, publicKey, since)
      },
      onChange: () => workspaceEvents.emit({ type: 'teammates' }),
      // Nothing a peer does should be able to fail quietly here. A snapshot
      // refused, a watch that could not be started: none of them stop the app,
      // and without this none of them leave a trace either — which is how a
      // sidebar showing a teammate's yesterday looks exactly like one showing
      // their today.
      onError: (error) => console.error('[teamwork]', error)
    })
  )
  // A teammate's view of this machine rides the same bus everything else does,
  // so a worktree created on the CLI reaches their sidebar for the same reason
  // it reaches this window's.
  workspaceEvents.on((event) => {
    // `teammates` is this service's own event. Feeding it back in would have a
    // link changing phase cost every peer a fresh snapshot of a workspace that
    // did not move.
    if (event.type === 'teammates') return
    // A project added or removed changes which checkouts are watched.
    if (event.type === 'projects') teamworkWatcher.sync(registry.context.store.listProjects())
    // The same line the service's own failures get. A reconcile that throws
    // after the project facts are in place leaves full rosters with no links,
    // and the panel then has to describe that state without ever being told
    // what happened — which was silence in the log and a lie on screen.
    if (event.type === 'projects' || event.type === 'members') {
      void peers.reconcile().catch((error: unknown) => console.error('[teamwork]', error))
    }
    peers.notifyWorkspaceChanged()
  })

  return { terminals, git, worktreeFiles, teamworkFiles: teamworkWatcher, peers, updates }
}

/**
 * Closes every pane of a worktree that has just been removed.
 *
 * The checkout is already gone by the time the event arrives, so nothing here
 * may depend on the directory: closing kills a process tree by pid, drops a
 * record by id and ends the streams, none of which needs a cwd. One at a time,
 * because each close reads and rewrites the same worktree's layout. And each
 * one on its own: a pane that will not die must not be the reason the rest of
 * them stay alive, so a failure is reported and the next pane is closed anyway.
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
