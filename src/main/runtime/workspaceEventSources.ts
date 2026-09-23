// Where workspace events actually come from.
//
// Each producer is attached to the thing that owns the state, never to a
// transport, which is what makes the stream transport-agnostic: the CLI and the
// GUI both reach the same service, so both mutations announce themselves.
//
// Three shapes of producer exist, because the services differ:
//   - git already emits its own state transitions (including the ones that
//     happen on a background task, long after the call returned), so that
//     emitter is simply bridged onto the bus.
//   - the terminal service announces only one transition of its own — a pane's
//     process ending, which no call causes — so that rides the manager's exit
//     report and every other terminal change is a mutating handler
//     re-registered wrapped: the wrapper publishes after the inner handler
//     succeeds. Registering a method twice is how the runtime already replaces
//     placeholders, so this needs nothing new from the registry.
//   - and the filesystem, which answers to nobody's call at all: files under a
//     checkout change because of an editor or a build, and a watcher is the
//     only way to hear about it.

import type { Terminal } from '../../shared/entities'
import { Params } from '../../shared/methods'
import type { GitService } from '../git'
import { degradedWatchReport, WorktreeWatcher, type WorktreeWatcherOptions } from '../git/worktreeWatcher'
import type { TerminalService } from '../terminals/method-handlers'
import type { MethodRegistry } from './methodRegistry'
import type { WorkspaceEventBus } from './workspaceEvents'

/**
 * Bridges git's own transitions onto the bus. Returns the detach function; the
 * runtime keeps the service for its whole life and so never calls it.
 */
export function publishGitEvents(git: GitService, bus: WorkspaceEventBus): () => void {
  return git.events.on((event) => {
    switch (event.type) {
      case 'project.added':
      case 'project.updated':
      case 'project.removed':
        bus.emit({ type: 'projects' })
        return
      default:
        // created / updated (creating -> ready | failed) / removed all mean the
        // same thing to a client: refetch the list.
        bus.emit({ type: 'worktrees' })
    }
  })
}

/**
 * The git calls that write, wrapped so they announce what they did.
 *
 * Every other git producer rides the service's own event emitter, which fires
 * for projects and for worktree lifecycle transitions and for nothing else. A
 * commit and a push change what `worktree.status` answers without changing any
 * record, so without this they are silent: a commit made through the CLI would
 * leave every open window describing the repository as it was.
 *
 * A commit currently gets noticed anyway, because it writes `index` and `HEAD`
 * and the filesystem watch below picks that up. That is luck rather than
 * design — a push changes only remote-tracking refs, which live in the common
 * git directory that no worktree watch covers — and relying on one producer to
 * cover for another is how a stream quietly stops being trustworthy.
 */
export function publishGitWrites(registry: MethodRegistry, git: GitService, bus: WorkspaceEventBus): void {
  registry.register('worktree.commit', Params.worktreeCommit, async (params) => {
    const result = await git.worktreeCommit(params)
    bus.emit({ type: 'worktrees' })
    return result
  })

  // Staging moves what `worktree.status` counts as staged and what either half
  // of the patch contains, and it does it without writing a file the watcher
  // below would notice — `.git/index` is inside the git directory, which the
  // watch covers, but relying on that is the same luck this function exists to
  // stop relying on.
  registry.register('worktree.stageHunk', Params.worktreeStageHunk, async (params) => {
    const result = await git.worktreeStageHunk(params)
    bus.emit({ type: 'worktrees' })
    return result
  })

  registry.register('worktree.unstageHunk', Params.worktreeUnstageHunk, async (params) => {
    const result = await git.worktreeUnstageHunk(params)
    bus.emit({ type: 'worktrees' })
    return result
  })

  registry.register('worktree.push', Params.worktreePush, async (params) => {
    const result = await git.worktreePush(params)
    // Ahead and behind moved even when nothing was sent: the remote-tracking
    // ref is now where the branch is.
    bus.emit({ type: 'worktrees' })
    return result
  })
}

/**
 * The third producer, and the only one that is not a consequence of a call:
 * files changing under a checkout because of something outside this app
 * entirely — an editor saving, a build writing, an agent's `git commit` in a
 * shell we are not watching the exit of.
 *
 * Git status is the one part of a worktree row with no call behind it, so
 * without this it is only ever as fresh as the last command boundary. The
 * watcher turns a settled burst of file changes into the same coarse
 * `worktrees` invalidation every other producer emits, and the client re-reads
 * the statuses it already knows how to re-read.
 *
 * The watch set follows git's own events, so a worktree becoming ready starts
 * being watched and a removed one stops, without anything polling.
 *
 * A watch can also be refused — a filesystem that cannot do it recursively, or
 * a machine with no inotify instances left, which takes only a handful of
 * editors and test runners on Linux. The watcher carries on with the git
 * directory alone when that happens, and this is the point where somebody has
 * to be told: the chips keep moving on commits and stop moving on edits, and
 * the difference is invisible from the outside.
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
    onChange: () => bus.emit({ type: 'worktrees' })
  })

  const resync = (): void => watcher.sync(git.snapshot().worktrees)
  // Records restored from a previous launch are already ready, so the first
  // sync has to happen now rather than waiting for a transition that will
  // never come.
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
 * to publish once the inner handler has succeeded. A failed call changes
 * nothing, so it must announce nothing.
 */
export function publishTerminalEvents(
  registry: MethodRegistry,
  terminals: TerminalService,
  bus: WorkspaceEventBus
): void {
  const { handlers, schemas } = terminals

  // A shell exiting on its own is nobody's method call, so the only way to hear
  // about it is the session's own lifecycle. The manager reports it for every
  // pane it started, which is what makes a pane restored at startup — started
  // before any of these handlers exist — announce its exit like any other.
  terminals.manager.onTerminalExit((terminalId, exitCode) => {
    bus.emit({ type: 'terminalExited', terminalId, exitCode })
    // The terminal's own record changed with it: `running` is false now.
    bus.emit({ type: 'terminals' })
  })

  const announceOpened = (terminal: Terminal): void => {
    bus.emit({ type: 'terminals' })
    // Opening a pane rewrites the worktree's tree, so the layout changed too.
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

  // The pane is running again, so `running`, `exitCode` and the agent it is
  // under have all changed. The layout has not: relaunch keeps the terminal id
  // and its leaf precisely so nothing has to move.
  registry.register('terminal.relaunch', schemas['terminal.relaunch'], async (params, call) => {
    const terminal = await handlers['terminal.relaunch'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  registry.register('terminal.close', schemas['terminal.close'], async (params, call) => {
    // Read before closing: afterwards the session is gone and with it the only
    // record of which worktree's layout just changed.
    const worktreeId = terminals.manager.list().find((terminal) => terminal.id === params.terminalId)?.worktreeId
    const result = await handlers['terminal.close'](params, call)
    bus.emit({ type: 'terminals' })
    if (worktreeId !== undefined) bus.emit({ type: 'layout', worktreeId })
    return result
  })

  // A name is what every client draws the pane with, so the rename has to
  // reach the windows that did not make the call — including the sidebar of
  // whoever renamed it, which reads the same list the strip does.
  registry.register('terminal.rename', schemas['terminal.rename'], async (params, call) => {
    const terminal = await handlers['terminal.rename'](params, call)
    bus.emit({ type: 'terminals' })
    return terminal
  })

  // The only keystroke worth announcing: the first one into a restored pane,
  // which retires its badge. Every other write changes nothing a client holds,
  // and publishing per keystroke would be absurd — hence the manager reporting
  // whether this particular write mattered rather than a blanket producer.
  //
  // Asked on both sides of the write rather than only before it, because not
  // every write retires the badge any more: an emulator answering the program's
  // own questions leaves a restored pane restored, and a pane that is still
  // restored has nothing to announce.
  registry.register('terminal.write', schemas['terminal.write'], async (params, call) => {
    const restored = (): boolean =>
      terminals.manager.list().some((terminal) => terminal.id === params.terminalId && terminal.restored !== undefined)
    const wasRestored = restored()
    const result = await handlers['terminal.write'](params, call)
    if (wasRestored && !restored()) bus.emit({ type: 'terminals' })
    return result
  })

  // terminal.resize is deliberately not a producer: the caller already gets the
  // new size back, and a drag-resize would otherwise invalidate the terminal
  // list on every frame.
  registry.register('layout.set', schemas['layout.set'], async (params, call) => {
    const layout = await handlers['layout.set'](params, call)
    bus.emit({ type: 'layout', worktreeId: layout.worktreeId })
    return layout
  })
}
