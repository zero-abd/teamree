// Per-machine switches the runtime acts on, read and written with
// `settings.get` / `settings.set`. Stored only once changed from the default.

export type RuntimeSettings = {
  /** Settings › Teamwork › Share Task Details: task lines, changed paths and team notes in presence. */
  shareTaskDetails: boolean
  /** Settings › Show Cost: ≈$ beside token counts. */
  showCost: boolean
  /** Settings › Add-ons › Jac Graph Memory. */
  jacMemoryAddon: boolean

  /** Settings › General › Show in Menu Bar: the macOS status item. */
  showInMenuBar: boolean
  /** Settings › Agents › Warn Agents About Overlaps: the edit-time hook and session-start context. */
  warnAgentsAboutOverlaps: boolean
  /** Settings › Panes › Keep Agents Running When teamree Quits: panes run in the pane host. Experimental; absent is off. */
  keepPanesRunning?: boolean

  /** Settings › General › Worktrees in: where new worktrees go when their project names no folder. */
  worktreesRoot?: string
  /** Settings › General › Branch prefix, `abd/`: leads branch names the runtime picks. */
  branchPrefix?: string
  /** Where new worktrees go with no folder set: the launch's `TEAMREE_WORKTREES_ROOT`, else the default. Read only. */
  worktreesRootFallback?: string
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  shareTaskDetails: true,
  showCost: false,
  jacMemoryAddon: false,
  showInMenuBar: true,
  warnAgentsAboutOverlaps: true
}
