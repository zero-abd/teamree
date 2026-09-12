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

import type { MethodRegistry } from '../methodRegistry'
import { GitService, registerGitHandlers } from '../../git'
import { createTerminalService, registerTerminalHandlers } from '../../terminals/method-handlers'
import type { TerminalService } from '../../terminals/method-handlers'
import { registerPlaceholderHandlers } from './placeholderHandlers'
import { registerStatusHandler } from './statusHandler'
import { registerUnsubscribeHandler } from './unsubscribeHandler'

/** Areas that own live OS resources and must be torn down when the app quits. */
export type RegisteredAreas = {
  terminals: TerminalService
  git: GitService
}

export function registerHandlers(registry: MethodRegistry): RegisteredAreas {
  registerPlaceholderHandlers(registry)
  registerStatusHandler(registry)
  registerUnsubscribeHandler(registry)

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

  const git = new GitService({ store: registry.context.store })
  // A create interrupted by a quit can never resume, so it is marked failed and
  // offered as a retry rather than left stuck in `creating`.
  git.reviveRestoredRecords()
  registerGitHandlers(registry, git)

  return { terminals, git }
}
