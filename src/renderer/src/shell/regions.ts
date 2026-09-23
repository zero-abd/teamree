// The window's keyboard regions, each the element marked `data-region`: F6 walks them, View's Focus
// items name them, and a region put away while it holds the focus hands it to the panes.

export type Region = 'sidebar' | 'strip' | 'panes' | 'panel'

/** F6's order, left to right as they are drawn. */
export const REGION_ORDER: readonly Region[] = ['sidebar', 'strip', 'panes', 'panel']

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Where the keyboard lands in each region, most specific first; else its first focusable control. */
const LANDING: Record<Region, readonly string[]> = {
  sidebar: ['[role="treeitem"][tabindex="0"]', '[role="treeitem"][aria-current="true"]', '[role="treeitem"]'],
  strip: ['[role="tab"][aria-selected="true"]'],
  // Terminal, then an editor, then a page such as All panes, which takes the focus itself.
  panes: ['.pane--focused .xterm-helper-textarea', '.pane--focused [contenteditable="true"]', '.page'],
  panel: ['[role="tab"][aria-selected="true"]']
}

export function regionOf(element: Element | null): Region | null {
  const name = element?.closest('[data-region]')?.getAttribute('data-region')
  return REGION_ORDER.find((region) => region === name) ?? null
}

/** The element the keyboard would land on in this region now, or null when it has none on screen. */
export function regionLanding(region: Region, root: ParentNode = document): HTMLElement | null {
  const containers = [...root.querySelectorAll(`[data-region="${region}"]`)]
  const within = (selector: string): HTMLElement | undefined =>
    containers
      .flatMap((container) => [...container.querySelectorAll<HTMLElement>(selector)])
      .find((element) => regionOf(element) === region && element.closest('[hidden]') === null)
  for (const selector of LANDING[region]) {
    const found = within(selector)
    if (found) return found
  }
  return within(FOCUSABLE) ?? null
}

export function focusRegion(region: Region, root: ParentNode = document): boolean {
  const landing = regionLanding(region, root)
  landing?.focus()
  return landing !== null && landing.ownerDocument.activeElement === landing
}

/** The next region along that has somewhere to land, from the one holding the focus; null when none has. */
export function regionAfter(
  from: Region | null,
  step: 1 | -1,
  root: ParentNode | undefined = globalThis.document
): Region | null {
  if (root === undefined) return null
  const at = from === null ? (step === 1 ? -1 : REGION_ORDER.length) : REGION_ORDER.indexOf(from)
  for (let offset = 1; offset <= REGION_ORDER.length; offset++) {
    const region = REGION_ORDER[(at + step * offset + REGION_ORDER.length * 2) % REGION_ORDER.length]
    if (region && region !== from && regionLanding(region, root) !== null) return region
  }
  return null
}

type Shown = { sidebarVisible: boolean; rightPanelOpen: boolean }

/** Where the focus goes when the sidebar or panel comes or goes: into one shown, out of one hidden while holding it. */
export function regionAfterToggle(next: Shown, previous: Shown, holding: Region | null): Region | null {
  if (next.sidebarVisible && !previous.sidebarVisible) return 'sidebar'
  if (next.rightPanelOpen && !previous.rightPanelOpen) return 'panel'
  const hidSidebar = !next.sidebarVisible && previous.sidebarVisible && holding === 'sidebar'
  const hidPanel = !next.rightPanelOpen && previous.rightPanelOpen && holding === 'panel'
  return hidSidebar || hidPanel ? 'panes' : null
}

let listener: ((region: Region) => void) | null = null

/** Focuses the region once the window has drawn what is on its way (see `RegionFocus`); at once with none mounted. */
export function requestRegionFocus(region: Region): void {
  if (listener) listener(region)
  else if (typeof document !== 'undefined') focusRegion(region)
}

export function onRegionRequest(next: (region: Region) => void): () => void {
  listener = next
  return () => {
    if (listener === next) listener = null
  }
}

/** The region holding the keyboard, or null with it on the page itself. */
export function focusedRegion(): Region | null {
  return typeof document === 'undefined' ? null : regionOf(document.activeElement)
}
