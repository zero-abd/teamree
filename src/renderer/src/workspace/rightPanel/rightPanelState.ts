// The right panel's tab, open state and width, remembered per machine (a habit, not a worktree fact).
// Read like the sidebar width: anything that is not what was written is the default.

export const RIGHT_PANEL_TABS = ['files', 'changes'] as const

export type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number]

export type RightPanelRecord = { open: boolean; tab: RightPanelTab }

export const RIGHT_PANEL_MIN_PX = 240
export const RIGHT_PANEL_MAX_PX = 720
export const RIGHT_PANEL_DEFAULT_PX = 340

const WIDTH_KEY = 'teamree.shell.rightPanelWidth'
const PANEL_KEY = 'teamree.shell.rightPanel'

/** Closed, on the files tab: what a machine that has never opened it gets. */
export function defaultRightPanel(): RightPanelRecord {
  return { open: false, tab: 'files' }
}

export function isRightPanelTab(value: unknown): value is RightPanelTab {
  return typeof value === 'string' && (RIGHT_PANEL_TABS as readonly string[]).includes(value)
}

export function clampRightPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_PANEL_DEFAULT_PX
  return Math.min(Math.max(Math.round(width), RIGHT_PANEL_MIN_PX), RIGHT_PANEL_MAX_PX)
}

export function readStoredRightPanelWidth(storage: Pick<Storage, 'getItem'> | undefined): number {
  try {
    const raw = storage?.getItem(WIDTH_KEY)
    return raw === null || raw === undefined ? RIGHT_PANEL_DEFAULT_PX : clampRightPanelWidth(Number.parseInt(raw, 10))
  } catch {
    return RIGHT_PANEL_DEFAULT_PX
  }
}

export function writeStoredRightPanelWidth(storage: Pick<Storage, 'setItem'> | undefined, width: number): void {
  try {
    storage?.setItem(WIDTH_KEY, String(clampRightPanelWidth(width)))
  } catch {
    // A blocked storage quota is not worth failing a drag over.
  }
}

export function readStoredRightPanel(storage: Pick<Storage, 'getItem'> | undefined): RightPanelRecord {
  const fallback = defaultRightPanel()
  try {
    const raw = storage?.getItem(PANEL_KEY)
    if (raw === null || raw === undefined) return fallback
    const record: unknown = JSON.parse(raw)
    if (typeof record !== 'object' || record === null) return fallback
    const fields = record as Partial<Record<keyof RightPanelRecord, unknown>>
    return {
      open: fields.open === true,
      tab: isRightPanelTab(fields.tab) ? fields.tab : fallback.tab
    }
  } catch {
    return fallback
  }
}

export function writeStoredRightPanel(storage: Pick<Storage, 'setItem'> | undefined, record: RightPanelRecord): void {
  try {
    storage?.setItem(PANEL_KEY, JSON.stringify({ open: record.open, tab: record.tab }))
  } catch {
    // Forgetting which tab was up is not worth failing the click that chose it.
  }
}

/** Whether anything on screen draws the changes (either tab: the list, or the files tab's letters); gates `git status`. */
export function changesOnScreen(state: { rightPanelOpen: boolean }): boolean {
  return state.rightPanelOpen
}
