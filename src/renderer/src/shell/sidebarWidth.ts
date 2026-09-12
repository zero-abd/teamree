// Sidebar width: clamped so the pane can never be dragged into uselessness,
// and remembered across launches because it is a per-person preference.

export const SIDEBAR_MIN_PX = 208
export const SIDEBAR_MAX_PX = 520
export const SIDEBAR_DEFAULT_PX = 272

const STORAGE_KEY = 'teamree.shell.sidebarWidth'

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_PX
  return Math.min(Math.max(Math.round(width), SIDEBAR_MIN_PX), SIDEBAR_MAX_PX)
}

export function readStoredSidebarWidth(storage: Pick<Storage, 'getItem'> | undefined): number {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? SIDEBAR_DEFAULT_PX : clampSidebarWidth(Number.parseInt(raw, 10))
  } catch {
    return SIDEBAR_DEFAULT_PX
  }
}

export function writeStoredSidebarWidth(storage: Pick<Storage, 'setItem'> | undefined, width: number): void {
  try {
    storage?.setItem(STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // A blocked storage quota is not worth failing a drag over.
  }
}
