// Where the window has been: the worktrees opened, in order, for Go Back and Go Forward, and when each
// was last left, for the palette. Kept in this window's `localStorage` beside the session.

/** One stay in a worktree; `at` is when it was entered, moved on when it is left. */
export type Visit = { worktreeId: string; paneId: string | null; at: number }

/** The stays in order, and which of them is on screen. */
export type VisitHistory = { visits: readonly Visit[]; index: number }

export const VISITS_KEPT = 50
export const EMPTY_VISITS: VisitHistory = { visits: [], index: -1 }

const STORAGE_KEY = 'teamree.workspace.visits'

function leaving(history: VisitHistory, now: number): Visit[] {
  return history.visits.map((entry, index) => (index === history.index ? { ...entry, at: now } : entry))
}

/** Arrived at `worktreeId`: the same stay when it is the one on screen, else a new one that drops what was ahead. */
export function visit(history: VisitHistory, worktreeId: string, paneId: string | null, now: number): VisitHistory {
  const here = history.visits[history.index]
  if (here?.worktreeId === worktreeId) {
    if (here.paneId === paneId) return history
    const visits = history.visits.map((entry, index) => (index === history.index ? { ...entry, paneId } : entry))
    return { visits, index: history.index }
  }
  const visits = [...leaving(history, now).slice(0, history.index + 1), { worktreeId, paneId, at: now }].slice(
    -VISITS_KEPT
  )
  return { visits, index: visits.length - 1 }
}

/** The nearest stay `step` away in another worktree still in `live`, and the history moved there; null when none. */
export function stepVisits(
  history: VisitHistory,
  step: 1 | -1,
  live: ReadonlySet<string>,
  now: number
): { history: VisitHistory; visit: Visit } | null {
  const here = history.visits[history.index]?.worktreeId
  for (let index = history.index + step; index >= 0 && index < history.visits.length; index += step) {
    const target = history.visits[index]
    if (target === undefined || target.worktreeId === here || !live.has(target.worktreeId)) continue
    const visits = leaving(history, now).map((entry, at) => (at === index ? { ...entry, at: now } : entry))
    return { history: { visits, index }, visit: target }
  }
  return null
}

/** When each worktree was last on screen, by id. */
export function lastVisits(history: VisitHistory): Record<string, number> {
  const last: Record<string, number> = {}
  for (const entry of history.visits) last[entry.worktreeId] = Math.max(last[entry.worktreeId] ?? 0, entry.at)
  return last
}

function isVisit(value: unknown): value is Visit {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.worktreeId === 'string' &&
    (entry.paneId === null || typeof entry.paneId === 'string') &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at)
  )
}

export function readStoredVisits(storage: Pick<Storage, 'getItem'> | undefined): VisitHistory {
  try {
    const record: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    if (typeof record !== 'object' || record === null) return EMPTY_VISITS
    const { visits, index } = record as Record<string, unknown>
    if (!Array.isArray(visits) || !visits.every(isVisit) || visits.length > VISITS_KEPT) return EMPTY_VISITS
    if (typeof index !== 'number' || !Number.isInteger(index) || index < -1 || index >= visits.length) {
      return EMPTY_VISITS
    }
    return { visits: visits.map(({ worktreeId, paneId, at }) => ({ worktreeId, paneId, at })), index }
  } catch {
    return EMPTY_VISITS
  }
}

export function writeStoredVisits(storage: Pick<Storage, 'setItem'> | undefined, history: VisitHistory): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    // Storage full or blocked: the history lasts until the window closes.
  }
}
