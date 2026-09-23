// What the window had open, remembered across launches. Anything not what was
// written is ignored, and storage that refuses is the same as nothing written.
// Not here: the changes panel's ticks, which would claim a review of a tree an agent may have moved on.

/** The window state that survives a quit. */
export type StoredSession = {
  openWorktreeIds: string[]
  activeWorktreeId: string | null
  /** Only the collapsed ones; expanded is the default and needs no record. */
  collapsedProjects: Record<string, boolean>
  sidebarVisible: boolean
}

const STORAGE_KEY = 'teamree.workspace.session'

/** More tabs than a window has ever had; a longer list is a broken record. */
const MAX_OPEN_TABS = 64

/** A window with no memory of the last one — what this app opened with before. */
export function emptySession(): StoredSession {
  return { openWorktreeIds: [], activeWorktreeId: null, collapsedProjects: {}, sidebarVisible: true }
}

export function readStoredSession(storage: Pick<Storage, 'getItem'> | undefined): StoredSession {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return emptySession()
    const record: unknown = JSON.parse(raw)
    if (typeof record !== 'object' || record === null) return emptySession()

    const fields = record as Partial<Record<keyof StoredSession, unknown>>
    const openWorktreeIds = readIds(fields.openWorktreeIds)
    const active = typeof fields.activeWorktreeId === 'string' ? fields.activeWorktreeId : null
    return {
      openWorktreeIds,
      // An active worktree with no tab is not a window anybody had.
      activeWorktreeId: active !== null && openWorktreeIds.includes(active) ? active : null,
      collapsedProjects: readCollapsed(fields.collapsedProjects),
      sidebarVisible: fields.sidebarVisible !== false
    }
  } catch {
    // A private window, cleared site data, or a record this version cannot read.
    return emptySession()
  }
}

export function writeStoredSession(storage: Pick<Storage, 'setItem'> | undefined, session: StoredSession): void {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        openWorktreeIds: session.openWorktreeIds.slice(0, MAX_OPEN_TABS),
        activeWorktreeId: session.activeWorktreeId,
        collapsedProjects: onlyCollapsed(session.collapsedProjects),
        sidebarVisible: session.sidebarVisible
      })
    )
  } catch {
    // Storage can be full or blocked; not worth failing the click that opened a tab.
  }
}

/** Whether two states differ in anything the record holds. */
export function sessionChanged(one: StoredSession, other: StoredSession): boolean {
  return (
    one.activeWorktreeId !== other.activeWorktreeId ||
    one.sidebarVisible !== other.sidebarVisible ||
    !sameOrder(one.openWorktreeIds, other.openWorktreeIds) ||
    !sameCollapsed(one.collapsedProjects, other.collapsedProjects)
  )
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return [...new Set(ids)].slice(0, MAX_OPEN_TABS)
}

function readCollapsed(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return onlyCollapsed(value as Record<string, unknown>)
}

function onlyCollapsed(projects: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(projects).filter(([, collapsed]) => collapsed === true)) as Record<
    string,
    boolean
  >
}

function sameOrder(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((id, index) => id === other[index])
}

function sameCollapsed(one: Record<string, boolean>, other: Record<string, boolean>): boolean {
  const collapsed = (projects: Record<string, boolean>): string[] =>
    Object.keys(onlyCollapsed(projects)).sort((a, b) => a.localeCompare(b))
  return sameOrder(collapsed(one), collapsed(other))
}
