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
//   - the terminal service has no lifecycle emitter, so its mutating handlers
//     are re-registered wrapped: the wrapper publishes after the inner handler
//     succeeds. Registering a method twice is how the runtime already replaces
//     placeholders, so this needs nothing new from the registry.
//   - and the filesystem, which answers to nobody's call at all: files under a
//     checkout change because of an editor or a build, and a watcher is the
//     only way to hear about it.

import type { Terminal } from '../../shared/entities'
import type { GitService } from '../git'
import { WorktreeWatcher, type WorktreeWatcherOptions } from '../git/worktreeWatcher'
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
 */
export function publishWorktreeFileEvents(
  git: GitService,
  bus: WorkspaceEventBus,
  options: Omit<WorktreeWatcherOptions, 'onChange'> = {}
): { close: () => void } {
  const watcher = new WorktreeWatcher({
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

  const announceOpened = (terminal: Terminal): void => {
    watchForExit(terminals, bus, terminal.id)
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

  registry.register('terminal.close', schemas['terminal.close'], async (params, call) => {
    // Read before closing: afterwards the session is gone and with it the only
    // record of which worktree's layout just changed.
    const worktreeId = terminals.manager.list().find((terminal) => terminal.id === params.terminalId)?.worktreeId
    const result = await handlers['terminal.close'](params, call)
    bus.emit({ type: 'terminals' })
    if (worktreeId !== undefined) bus.emit({ type: 'layout', worktreeId })
    return result
  })

  // The only keystroke worth announcing: the first one into a restored pane,
  // which retires its badge. Every other write changes nothing a client holds,
  // and publishing per keystroke would be absurd — hence the manager reporting
  // whether this particular write mattered rather than a blanket producer.
  registry.register('terminal.write', schemas['terminal.write'], async (params, call) => {
    const wasRestored = terminals.manager
      .list()
      .some((terminal) => terminal.id === params.terminalId && terminal.restored !== undefined)
    const result = await handlers['terminal.write'](params, call)
    if (wasRestored) bus.emit({ type: 'terminals' })
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

/**
 * A shell exiting on its own is nobody's method call, so the only way to hear
 * about it is the terminal's own event stream. This attaches one that ignores
 * output and waits for the exit, which is cheap: the session already fans its
 * events out to whatever is listening.
 */
function watchForExit(terminals: TerminalService, bus: WorkspaceEventBus, terminalId: string): void {
  let detach = (): void => {}
  detach = terminals.manager.attachStream(terminalId, {
    emit: (event) => {
      if (event.type !== 'exit') return
      detach()
      bus.emit({ type: 'terminalExited', terminalId, exitCode: event.exitCode })
      // The terminal's own record changed with it: `running` is false now.
      bus.emit({ type: 'terminals' })
    },
    // The manager ends this stream when the terminal goes; its own teardown has
    // already detached us by then.
    close: () => {}
  })
}
