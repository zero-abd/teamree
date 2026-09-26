// Where workspace events come from. Each producer is attached to the service
// that owns the state, never to a transport: git's emitter is bridged, mutating
// terminal handlers are re-registered wrapped, and a watcher covers the filesystem.

import type { Terminal } from '../../shared/entities'
import { Params } from '../../shared/methods'
import type { GitService } from '../git'
import { degradedWatchReport, WorktreeWatcher, type WorktreeWatcherOptions } from '../git/worktreeWatcher'
import type { TerminalService } from '../terminals/method-handlers'
import type { MethodRegistry } from './methodRegistry'
import type { WorkspaceEventBus } from './workspaceEvents'

/** A worktree and the children measured against its branch. */
export function withChildren(git: GitService, worktreeId: string): string[] {
  const children = git.snapshot().worktrees.filter((worktree) => worktree.parentId === worktreeId)
  return [worktreeId, ...children.map((child) => child.id)]
}

/** Every worktree of a project, for a change to the base they are all measured against. */
export function projectWorktreeIds(git: GitService, projectId: string): string[] {
  return git
    .snapshot()
    .worktrees.filter((worktree) => worktree.projectId === projectId)
    .map((worktree) => worktree.id)
}

/** Bridges git's own transitions onto the bus. Returns the detach function. */
export function publishGitEvents(git: GitService, bus: WorkspaceEventBus): () => void {
  return git.events.on((event) => {
    switch (event.type) {
      case 'project.added':
      case 'project.updated':
      case 'project.removed':
        bus.emit({ type: 'projects' })
        return
      case 'worktree.removed':
        bus.emit({ type: 'worktrees', worktreeIds: [event.worktreeId] })
        return
      default:
        // A rename or a re-nest moves what its children are measured against.
        bus.emit({ type: 'worktrees', worktreeIds: withChildren(git, event.worktree.id) })
    }
  })
}

/**
 * The git calls that write, wrapped to announce what they did: they change what
 * `worktree.status` answers without changing any record. A push moves only
 * remote-tracking refs, in the common git directory no worktree watch covers.
 */
export function publishGitWrites(registry: MethodRegistry, git: GitService, bus: WorkspaceEventBus): void {
  registry.register('worktree.commit', Params.worktreeCommit, async (params) => {
    const result = await git.worktreeCommit(params)
    bus.emit({ type: 'worktrees', worktreeIds: withChildren(git, params.worktreeId) })
    return result
  })

  // Staging moves the counts and both halves of the patch; the watch noticing
  // `.git/index` is luck, not design.
  registry.register('worktree.stageHunk', Params.worktreeStageHunk, async (params) => {
    const result = await git.worktreeStageHunk(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.unstageHunk', Params.worktreeUnstageHunk, async (params) => {
    const result = await git.worktreeUnstageHunk(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.unstagePath', Params.worktreeUnstagePath, async (params) => {
    const result = await git.worktreeUnstagePath(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  // Discarding writes the working tree; announced for the same reason staging is.
  registry.register('worktree.discardPath', Params.worktreeDiscardPath, async (params) => {
    const result = await git.worktreeDiscardPath(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.discardHunk', Params.worktreeDiscardHunk, async (params) => {
    const result = await git.worktreeDiscardHunk(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.undoDiscard', Params.worktreeUndoDiscard, async (params) => {
    const result = await git.undoDiscard(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.push', Params.worktreePush, async (params) => {
    const result = await git.worktreePush(params)
    // Ahead and behind moved even when nothing was sent.
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  registry.register('worktree.update', Params.worktreeUpdate, async (params) => {
    const result = await git.worktreeUpdate(params)
    bus.emit({ type: 'worktrees', worktreeIds: withChildren(git, params.worktreeId) })
    return result
  })

  registry.register('worktree.abortUpdate', Params.worktreeAbortUpdate, async (params) => {
    const result = await git.worktreeAbortUpdate(params)
    bus.emit({ type: 'worktrees', worktreeIds: withChildren(git, params.worktreeId) })
    return result
  })

  registry.register('worktree.continueUpdate', Params.worktreeContinueUpdate, async (params) => {
    const result = await git.worktreeContinueUpdate(params)
    bus.emit({ type: 'worktrees', worktreeIds: withChildren(git, params.worktreeId) })
    return result
  })

  registry.register('worktree.resolve', Params.worktreeResolve, async (params) => {
    const result = await git.worktreeResolve(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })

  // A merge moves the base every row of the project is measured against; a pull request is a landing of its own.
  registry.register('worktree.mergeIntoBase', Params.worktreeMergeIntoBase, async (params) => {
    const projectId = git.snapshot().worktrees.find((worktree) => worktree.id === params.worktreeId)?.projectId
    const result = await git.worktreeMergeIntoBase(params)
    if (!result.merged) return result
    bus.emit(
      projectId === undefined
        ? { type: 'worktrees' }
        : { type: 'worktrees', worktreeIds: projectWorktreeIds(git, projectId) }
    )
    return result
  })

  // Moving the base, or origin's, changes which landings read as not pushed.
  registry.register('project.pushBase', Params.projectPushBase, async (params) => {
    const result = await git.projectPushBase(params)
    bus.emit({ type: 'worktrees', worktreeIds: projectWorktreeIds(git, params.projectId) })
    return result
  })

  registry.register('project.pullBase', Params.projectPullBase, async (params) => {
    const result = await git.projectPullBase(params)
    bus.emit({ type: 'worktrees', worktreeIds: projectWorktreeIds(git, params.projectId) })
    return result
  })

  registry.register('worktree.createPullRequest', Params.worktreeCreatePullRequest, async (params) => {
    const result = await git.worktreeCreatePullRequest(params)
    bus.emit({ type: 'worktrees', worktreeIds: [params.worktreeId] })
    return result
  })
}

/**
 * The producer that is not a consequence of a call: files changing under a
 * checkout. The watch set follows git's own events. A refused watch (no inotify
 * instances left) is reported here, since chips then stop moving on edits and nothing shows it.
 */
export function publishWorktreeFileEvents(
  git: GitService,
  bus: WorkspaceEventBus,
  options: Omit<WorktreeWatcherOptions, 'onChange'> = {}
): { close: () => void } {
  const watcher = new WorktreeWatcher({
    onError: (error) => console.warn('[worktrees] a filesystem watch failed', error),
    onDegraded: (event) => console.warn(`[worktrees] ${degradedWatchReport(event)}`),
    ...options,
    onChange: (change) => {
      bus.emit({ type: 'worktrees', ...change })
      // A checkout deleted outside the app reports as a change inside it; only a look says it went.
      if (change.worktreeIds !== undefined) void git.recheckCheckouts(change.worktreeIds).catch(() => undefined)
    }
  })

  const resync = (): void => watcher.sync(git.snapshot().worktrees)
  // Records restored from a previous launch are already ready, so sync now.
  resync()
  const detach = git.events.on(resync)

  return {
    close: () => {
      detach()
      watcher.close()
    }
  }
}

/**
 * Re-registers the terminal and layout methods that change state, each wrapped
 * to publish once the inner handler has succeeded.
 */
export function publishTerminalEvents(
  registry: MethodRegistry,
  terminals: TerminalService,
  bus: WorkspaceEventBus
): void {
  const { handlers, schemas } = terminals

  // A shell exiting on its own is nobody's method call; the manager reports it
  // for every pane it started, restored ones included.
  terminals.manager.onTerminalExit((terminalId, exitCode) => {
    bus.emit({ type: 'terminalExited', terminalId, exitCode })
    // `running` is false now.
    bus.emit({ type: 'terminals' })
  })

  // The manager reports only the writes that retired a badge a client holds. A
  // listener rather than a wrapper around `terminal.write` because the edge is
  // invisible from out here: the bell it rang a byte ago has already gone.
  terminals.manager.onPaneAnswered(() => {
    bus.emit({ type: 'terminals' })
  })

  const announceOpened = (terminal: Terminal): void => {
    bus.emit({ type: 'terminals' })
    // Opening a pane rewrites the worktree's tree.
    bus.emit({ type: 'layout', worktreeId: terminal.worktreeId })
  }

  registry.register('terminal.create', schemas['terminal.create'], async (params, call) => {
    const terminal = await handlers['terminal.create'](params, call)
    announceOpened(terminal)
    return terminal
  })

  registry.register('terminal.split', schemas['terminal.split'], async (params, call) => {
    const result = await handlers['terminal.split'](params, call)
    announceOpened(result.terminal)
    return result
  })

  registry.register('terminal.reopen', schemas['terminal.reopen'], async (params, call) => {
    const terminal = await handlers['terminal.reopen'](params, call)
    announceOpened(terminal)
    return terminal
  })

  // The record changed; the layout has not, since relaunch keeps the terminal id.
  registry.register('terminal.relaunch', schemas['terminal.relaunch'], async (params, call) => {
    const terminal = await handlers['terminal.relaunch'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  // Reported from inside the agent's process over the CLI socket; the window
  // drawing the sidebar is never the caller.
  registry.register('terminal.agentEvent', schemas['terminal.agentEvent'], async (params, call) => {
    const terminal = await handlers['terminal.agentEvent'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  registry.register('terminal.subagentEvent', schemas['terminal.subagentEvent'], async (params, call) => {
    const terminal = await handlers['terminal.subagentEvent'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  registry.register('terminal.close', schemas['terminal.close'], async (params, call) => {
    // Read before closing: afterwards neither the session nor the leaf is there.
    const worktreeId = terminals.manager.paneWorktree(params.terminalId)
    const result = await handlers['terminal.close'](params, call)
    bus.emit({ type: 'terminals' })
    if (worktreeId !== undefined) bus.emit({ type: 'layout', worktreeId })
    return result
  })

  // The rename has to reach the windows that did not make the call.
  registry.register('terminal.rename', schemas['terminal.rename'], async (params, call) => {
    const terminal = await handlers['terminal.rename'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  // terminal.resize is deliberately not a producer: a drag-resize would
  // invalidate the terminal list on every frame.
  registry.register('layout.set', schemas['layout.set'], async (params, call) => {
    const layout = await handlers['layout.set'](params, call)
    bus.emit({ type: 'layout', worktreeId: layout.worktreeId })
    return layout
  })
}
