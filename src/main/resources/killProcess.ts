// SIGTERM, and only SIGTERM: a program asked politely gets to write its files
// out first. Closing the pane still escalates (see `../terminals/process-tree.ts`).

import type { KillTarget } from './resourceTree'

export type KillSignal = (target: number, signal: NodeJS.Signals) => void

export function terminate(target: KillTarget, kill: KillSignal = defaultKill): void {
  if (target.kind === 'group') {
    // The negated pid reaches the whole session; a child leading no group
    // (ESRCH on the group) gets the signal itself.
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
