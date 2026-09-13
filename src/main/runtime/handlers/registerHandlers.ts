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
import { GitService, registerGitHandlers } from '../../git'
import { registerTeamworkHandlers, TeamworkService } from '../../teamwork'
import { PeerService, registerPeerHandlers } from '../../teamwork/peer'
import { createTerminalService, registerTerminalHandlers } from '../../terminals/method-handlers'
import type { TerminalService } from '../../terminals/method-handlers'
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
   * Outbound relay connections, one per teammate. Started after the dispatcher
   * exists, because a peer that reached a half-built registry would be told a
   * method does not exist when it merely does not exist yet.
   */
  peers: PeerService
}

export function registerHandlers(registry: MethodRegistry): RegisteredAreas {
  registerPlaceholderHandlers(registry)
  registerStatusHandler(registry)
  registerUnsubscribeHandler(registry)
  registerWorkspaceSubscribeHandler(registry)
  const workspaceEvents = registry.context.workspaceEvents

  const terminals = createTerminalService({
    subscriptions: registry.context.subscriptions,
    // Terminals open in their worktree's checkout, so the store is the authority
    // on where that is.
    resolveWorktreeCwd: (worktreeId) => registry.context.store.getWorktree(worktreeId)?.path,
    layouts: registry.context.store,
    sessions: registry.context.store,
    // A pane going busy or quiet is the only thing this app knows about what an
    // agent is doing, and it is what the sidebar reads. Two events per burst of
    // work, not one per chunk of output.
    onActivityChange: () => workspaceEvents.emit({ type: 'terminals' })
  })
  // Terminals first: each recorded one comes back under the id its panes
  // already name, and an agent pane comes back with its conversation resumed.
  terminals.restoreSessions()
  // Then the layouts, for whatever did not come back — a worktree deleted while
  // the app was closed, a shell that no longer exists. Without this the UI
  // renders panes bound to dead ids.
  terminals.reconcileLayouts()
  registerTerminalHandlers(registry, terminals)
  // Wraps the handlers just registered, so every terminal and layout change
  // reaches the workspace stream whichever transport asked for it.
  publishTerminalEvents(registry, terminals, workspaceEvents)

  const git = new GitService({ store: registry.context.store })
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
  registerTeamworkHandlers(
    registry,
    new TeamworkService({
      store: registry.context.store,
      dataDir,
      // Joining writes a file that no watcher covers — `.teamree/members` lives
      // in the primary checkout, which nothing here watches — so the service is
      // the only thing that can say the roster moved.
      onRosterChange: () => workspaceEvents.emit({ type: 'members' })
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
    if (event.type === 'projects' || event.type === 'members') void peers.reconcile().catch(() => {})
    peers.notifyWorkspaceChanged()
  })

  return { terminals, git, worktreeFiles, peers }
}
