// Resume All: the ended agent panes whose Resume picks their own conversation back up. Nothing else is
// offered, so a task is never sent again and no fresh agent starts under the word.

import type { Terminal } from '@shared/entities'

/** Ended agent panes that can resume, in `worktreeId` when given. */
export function resumableAgents(terminals: Iterable<Terminal>, worktreeId?: string): Terminal[] {
  return [...terminals].filter(
    (terminal) =>
      terminal.resumable === true &&
      terminal.agent !== undefined &&
      terminal.run === undefined &&
      (worktreeId === undefined || terminal.worktreeId === worktreeId)
  )
}

/** "3 agents stopped", for the notice after a relaunch. */
export function stoppedAgentsText(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} stopped`
}
