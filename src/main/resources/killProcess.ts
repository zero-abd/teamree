// SIGTERM, and only SIGTERM.
//
// Closing a pane escalates to SIGKILL (see `../terminals/process-tree.ts`)
// because a closed pane has to end. This is a person pointing at one row of a
// list and asking it to stop, and a program asked politely gets to write its
// files out first. If it ignores that, the row is still there to press again,
// and the pane's own close is still there for the whole tree.

import type { KillTarget } from './resourceTree'

export type KillSignal = (target: number, signal: NodeJS.Signals) => void

export function terminate(target: KillTarget, kill: KillSignal = defaultKill): void {
  if (target.kind === 'group') {
    // The negated pid reaches the whole session the pty child leads. A child
    // that leads no group — ESRCH on the group, not on the pid — gets the
    // signal itself instead, which is what the row promised.
    if (send(-target.pid, kill)) return
  }
  send(target.pid, kill)
}

/** True when the signal was delivered. A process already gone is not a failure. */
function send(target: number, kill: KillSignal): boolean {
  try {
    kill(target, 'SIGTERM')
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw error
  }
}

function defaultKill(target: number, signal: NodeJS.Signals): void {
  process.kill(target, signal)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
