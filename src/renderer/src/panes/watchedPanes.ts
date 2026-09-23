// A teammate's pane as one of this window's panes: an id usable wherever a pane id goes, and the
// focus order. The slot is the window's, not a tab's, so switching tabs does not close and reopen the
// subscription.

import type { PaneNode } from '@shared/entities'
import { collectTerminalIds } from './paneLayout'

/** The prefix marking a teammate's pane id; without it `terminal.close` could target their laptop. */
export const WATCHED_PANE_PREFIX = 'watch:'

/** How much of a watched pane is kept, to quote its last line from. */
export const WATCH_TAIL_CHARS = 4_000

/** A teammate's pane, open here, as the window holds it. */
export type WatchedPane = {
  /** The id this pane answers to in this window. See `watchedPaneId`. */
  id: string
  projectId: string
  /** The namespaced id `teamwork.presence` hands out, not the owner's own. */
  paneId: string
  /** What to call the pane, as the sidebar already names it. */
  label: string
  handle: string
}

/** The id a watched pane answers to here; includes the project, since pane ids are unique only within one. */
export function watchedPaneId(projectId: string, paneId: string): string {
  return `${WATCHED_PANE_PREFIX}${projectId}:${paneId}`
}

export function isWatchedPaneId(id: string): boolean {
  return id.startsWith(WATCHED_PANE_PREFIX)
}

/** The focus chord's order: your panes as laid out, then teammates' in opening order, as drawn. */
export function paneCycle(root: PaneNode | null, watches: readonly WatchedPane[]): string[] {
  return [...collectTerminalIds(root), ...watches.map((watch) => watch.id)]
}

/** Where focus lands when `id` closes (the next, else previous, as `neighbourTerminalId`), or null. */
export function neighbourWatchId(watches: readonly WatchedPane[], id: string): string | null {
  const index = watches.findIndex((watch) => watch.id === id)
  if (index === -1) return null
  const remaining = watches.filter((watch) => watch.id !== id)
  return (remaining[index] ?? remaining[index - 1])?.id ?? null
}
