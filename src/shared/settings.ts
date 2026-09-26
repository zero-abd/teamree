// Per-machine switches the runtime acts on, read and written with
// `settings.get` / `settings.set`. Stored only once changed from the default.

export type RuntimeSettings = {
  /** Settings › Teamwork › Share Task Details: task lines, changed paths and team notes in presence. */
  shareTaskDetails: boolean
  /** Settings › Show Cost: ≈$ beside token counts. */
  showCost: boolean
  /** Settings › Add-ons › Jac Graph Memory. */
  jacMemoryAddon: boolean
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  shareTaskDetails: true,
  showCost: false,
  jacMemoryAddon: false
}
