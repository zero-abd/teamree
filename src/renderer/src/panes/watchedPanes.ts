// A teammate's pane, as one of this window's panes.
//
// Watching used to be a card that floated over the window, pinned to the bottom
// right corner at a size nobody could change. That made the one surface in the
// app that shows somebody else's machine the one surface that did not behave
// like the app: it could not be moved, could not be resized, could not be
// closed with the chord that closes panes, and sat on top of whatever was
// underneath it. So a watched pane takes a slot beside your own panes instead,
// and what is here is the little it costs to let it: an id it can be addressed
// by everywhere a pane id goes, and the order the focus chord walks.
//
// The slot is the window's rather than a worktree tab's, and that is not an
// accident of where it was easiest to put. A teammate's pane is a checkout on
// their machine, which no tab of yours is about; and a pane that moved between
// tabs would unmount as you switched, which closes the subscription and reopens
// it — paying the relay's budget twice for a pane nobody stopped watching.

import type { PaneNode } from '@shared/entities'
import { collectTerminalIds } from './paneLayout'

/**
 * What marks an id as a teammate's pane rather than one of this machine's.
 *
 * A terminal id is the runtime's and is opaque to this window, so the prefix is
 * the only thing that keeps the two apart — and they have to be kept apart,
 * because from here on a single `focusPane` and a single close chord carry
 * both. An id that could be read either way would point `terminal.close` at a
 * pane on somebody else's laptop.
 */
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

/**
 * The id a watched pane answers to here.
 *
 * The project is in it because a pane id is only unique within the project it
 * was published in: two projects can hold a teammate of the same name, and
 * nothing on either side stops them numbering a pane the same way.
 */
export function watchedPaneId(projectId: string, paneId: string): string {
  return `${WATCHED_PANE_PREFIX}${projectId}:${paneId}`
}

export function isWatchedPaneId(id: string): boolean {
  return id.startsWith(WATCHED_PANE_PREFIX)
}

/**
 * The order the focus chord walks: your own panes as the tree lays them out,
 * then the teammates' panes in the order they were opened.
 *
 * Which is also the order they are drawn in, left to right, so pressing the
 * chord moves the focus the way the window reads rather than the way this
 * window happens to store things.
 */
export function paneCycle(root: PaneNode | null, watches: readonly WatchedPane[]): string[] {
  return [...collectTerminalIds(root), ...watches.map((watch) => watch.id)]
}

/**
 * The watched pane the focus should land on once `id` closes, or null to give
 * it back to your own tree.
 *
 * The one that takes its place on the screen, and the one before it if it was
 * last — the same rule `neighbourTerminalId` applies to a local pane, so that
 * holding the close chord walks the row rather than jumping out of it.
 */
export function neighbourWatchId(watches: readonly WatchedPane[], id: string): string | null {
  const index = watches.findIndex((watch) => watch.id === id)
  if (index === -1) return null
  const remaining = watches.filter((watch) => watch.id !== id)
  return (remaining[index] ?? remaining[index - 1])?.id ?? null
}
