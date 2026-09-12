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

import type { MethodRegistry } from '../methodRegistry'
import { GitService, registerGitHandlers } from '../../git'
import { createTerminalService, registerTerminalHandlers } from '../../terminals/method-handlers'
import type { TerminalService } from '../../terminals/method-handlers'
import { registerPlaceholderHandlers } from './placeholderHandlers'
import { registerStatusHandler } from './statusHandler'
import { registerUnsubscribeHandler } from './unsubscribeHandler'
import { registerWorkspaceSubscribeHandler } from './workspaceSubscribeHandler'
import { publishGitEvents, publishTerminalEvents } from '../workspaceEventSources'

/** Areas that own live OS resources and must be torn down when the app quits. */
export type RegisteredAreas = {
  terminals: TerminalService
  git: GitService
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
    layouts: registry.context.store
  })
  // Layouts outlive the app; the terminals they point at do not. Reconciling on
  // the way up is what stops the UI rendering panes bound to dead terminals.
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

  return { terminals, git }
}
