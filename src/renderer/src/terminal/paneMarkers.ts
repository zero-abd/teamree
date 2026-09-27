// Draws `.pane-marker` over each marker line main wrote into the scrollback (see `paneMarker.ts`): the
// line stays in the text, for reads and copies, and the pane shows a rule with its label on it.

import type { IBuffer, IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { markerLabel } from '@shared/paneMarker'

/** The marker lines between `from` and `to` in the buffer, as absolute line numbers and labels. */
export function markerRows(buffer: IBuffer, from: number, to: number): { line: number; label: string }[] {
  const found: { line: number; label: string }[] = []
  for (let line = Math.max(0, from); line < Math.min(to, buffer.length); line++) {
    const text = buffer.getLine(line)?.translateToString(true)
    const label = text === undefined ? null : markerLabel(text)
    if (label !== null) found.push({ line, label })
  }
  return found
}

/** How far back each scan looks past the screen: output in one frame rarely scrolls more. */
const SCAN_BEHIND = 200

/** Decorates marker lines as they are written; `scan(true)` looks at the whole buffer, after a replay. */
export function paneMarkers(term: Terminal): { scan: (whole?: boolean) => void; dispose: () => void } {
  const drawn = new Map<IMarker, IDecoration>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let whole = false

  const run = (): void => {
    timer = null
    const buffer = term.buffer.active
    if (buffer.type !== 'normal') return
    const taken = new Set([...drawn.keys()].map((marker) => marker.line))
    const from = whole ? 0 : buffer.length - term.rows - SCAN_BEHIND
    whole = false
    for (const { line, label } of markerRows(buffer, from, buffer.length)) {
      if (taken.has(line)) continue
      const marker = term.registerMarker(line - (buffer.baseY + buffer.cursorY))
      if (marker === undefined) continue
      const decoration = term.registerDecoration({ marker, width: term.cols, layer: 'top' })
      if (decoration === undefined) {
        marker.dispose()
        continue
      }
      decoration.onRender((element) => {
        // Its width in cells is fixed when registered; the screen's, read at each render, follows a resize.
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
        if (screen) element.style.width = `${screen.clientWidth}px`
        if (element.classList.contains('pane-marker')) return
        element.classList.add('pane-marker')
        element.textContent = label
      })
      drawn.set(marker, decoration)
      marker.onDispose(() => {
        drawn.get(marker)?.dispose()
        drawn.delete(marker)
      })
    }
  }

  return {
    scan: (all = false) => {
      whole ||= all
      if (timer === null) timer = setTimeout(run, 120)
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      for (const [marker, decoration] of drawn) {
        decoration.dispose()
        marker.dispose()
      }
      drawn.clear()
    }
  }
}
