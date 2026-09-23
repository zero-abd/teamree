// When to ask a pane what it last printed, and how little to ask for. A
// subscription would stream every byte into the renderer, so reads are rationed:
// on-screen panes only, no oftener than the eye can use, only after new output, once more after exit.

import type { Terminal } from '@shared/entities'

/**
 * How much of the tail to ask for: enough for an emulator to rebuild the rows a
 * full-screen agent last redrew, not only the few it touched since; a small slice of the retained scrollback.
 */
export const EVIDENCE_TAIL_BYTES = 64 * 1024

/** Floor on the spacing between reads of one pane; not every frame of a spinner. */
export const EVIDENCE_INTERVAL_MS = 1500

/** Reads started per tick; the ones left over are first in line next tick. */
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
  // Oldest first; a pane never read goes ahead of every pane that has been.
  due.sort((a, b) => lastReadAt(plan.reads[a.id]) - lastReadAt(plan.reads[b.id]))
  return due.slice(0, limit).map((terminal) => terminal.id)
}

/** Drops what is remembered about panes the runtime no longer lists. */
export function forgetClosed<T>(known: Record<string, T>, terminals: Record<string, Terminal>): Record<string, T> {
  const entries = Object.entries(known).filter(([terminalId]) => terminalId in terminals)
  return entries.length === Object.keys(known).length ? known : Object.fromEntries(entries)
}

function isDue(terminal: Terminal, read: EvidenceRead | undefined, now: number, intervalMs: number): boolean {
  if (!read) return true
  // Read once after the exit, then stop: a dead PTY writes nothing more.
  if (!terminal.running) return read.wasRunning
  if (now - read.readAt < intervalMs) return false
  // Busy means bytes are still arriving; `lastOutputAt` only advances on the edges of the burst.
  if (terminal.busy) return true
  return terminal.lastOutputAt > read.readAt
}

function lastReadAt(read: EvidenceRead | undefined): number {
  return read?.readAt ?? Number.NEGATIVE_INFINITY
}
