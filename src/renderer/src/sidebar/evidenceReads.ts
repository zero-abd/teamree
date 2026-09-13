// When to ask a pane what it last printed, and how little to ask for.
//
// `terminal.read` is a snapshot, so evidence costs one call per pane per read.
// Nothing here subscribes to output instead: a subscription streams every byte
// an agent prints into the renderer, which is the right price for a pane the
// user is watching and an absurd one for a row that shows a single line.
//
// So reads are rationed four ways. Only panes actually on screen are read at
// all. A pane is re-read no oftener than the eye can use. A pane that has gone
// quiet is read only if output has arrived since the last read — a shell
// sitting at its prompt costs nothing after the first one. And a pane that has
// exited is read once more and then never again, because its output cannot
// change.

import type { Terminal } from '@shared/entities'

/**
 * How much of the tail to ask for. Enough to walk back through a prompt, a run
 * of blank lines and a redrawn progress line to real output; small enough that
 * reading every visible pane costs less than one screen of terminal text. The
 * retained scrollback is a thousand times this.
 */
export const EVIDENCE_TAIL_BYTES = 4096

/** Floor on the spacing between reads of one pane. Fast enough that a row
 *  tracks work as it happens, slow enough that a pane printing continuously is
 *  not re-read for every frame of its spinner. */
export const EVIDENCE_INTERVAL_MS = 1500

/** Reads started per tick. A project with thirty panes open should not fan out
 *  thirty calls at once; the ones left over are first in line next tick. */
export const EVIDENCE_READS_PER_TICK = 6

/** What happened the last time a pane was read. */
export type EvidenceRead = {
  readAt: number
  /** Whether the pane was still running then; if not, it is finished with. */
  wasRunning: boolean
}

export type EvidenceReadPlan = {
  visible: readonly Terminal[]
  reads: Readonly<Record<string, EvidenceRead>>
  now: number
  intervalMs?: number
  limit?: number
}

/** The panes to read on this tick, most overdue first. */
export function terminalsToRead(plan: EvidenceReadPlan): string[] {
  const intervalMs = plan.intervalMs ?? EVIDENCE_INTERVAL_MS
  const limit = plan.limit ?? EVIDENCE_READS_PER_TICK

  const due = plan.visible.filter((terminal) => isDue(terminal, plan.reads[terminal.id], plan.now, intervalMs))
  // Oldest first, and a pane never read before goes ahead of every pane that
  // has been, so a row with nothing to show gets something soonest.
  due.sort((a, b) => lastReadAt(plan.reads[a.id]) - lastReadAt(plan.reads[b.id]))
  return due.slice(0, limit).map((terminal) => terminal.id)
}

/** Drops what is remembered about panes the runtime no longer lists, so closing
 *  terminals does not leave the map growing for the life of the window. */
export function forgetClosed<T>(known: Record<string, T>, terminals: Record<string, Terminal>): Record<string, T> {
  const entries = Object.entries(known).filter(([terminalId]) => terminalId in terminals)
  return entries.length === Object.keys(known).length ? known : Object.fromEntries(entries)
}

function isDue(terminal: Terminal, read: EvidenceRead | undefined, now: number, intervalMs: number): boolean {
  if (!read) return true
  // Read once after the exit so the row settles on the last thing the process
  // said, then stop: a dead PTY writes nothing more.
  if (!terminal.running) return read.wasRunning
  if (now - read.readAt < intervalMs) return false
  // Busy means bytes are still arriving, so the last line is moving even though
  // `lastOutputAt` only advances on the edges of that burst.
  if (terminal.busy) return true
  // Quiet: the pane has said nothing since the last read, so a read would fetch
  // the same bytes and pick the same line out of them.
  return terminal.lastOutputAt > read.readAt
}

function lastReadAt(read: EvidenceRead | undefined): number {
  return read?.readAt ?? Number.NEGATIVE_INFINITY
}
