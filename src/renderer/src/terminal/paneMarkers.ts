// Draws `.pane-marker` over each marker line main wrote into the scrollback (see `paneMarker.ts`): the
// line stays in the text, for reads and copies, and the pane shows a rule with its label on it.

import type { IBuffer, IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { markerLabel } from '@shared/paneMarker'

/** The marker lines between `from` and `to` in the buffer, as absolute line numbers and labels. */
export function markerRows(buffer: IBuffer, from: number, to: number): { line: number; label: string }[] {
  const found: { line: number; label: string }[] = []
  for (let line = Math.max(0, from); line < Math.min(to, buffer.length); line++) {
    const label = labelAt(buffer, line)
    if (label !== null) found.push({ line, label })
  }
  return found
}

function labelAt(buffer: IBuffer, line: number): string | null {
  const text = buffer.getLine(line)?.translateToString(true)
  return text === undefined ? null : markerLabel(text)
}

/**
 * Decorates marker lines as they are written; `scan(true)` looks at the whole buffer, after a replay.
 * Each rule rides an xterm marker, so it scrolls, reflows and is cleared with its line.
 */
export function paneMarkers(term: Terminal): { scan: (whole?: boolean) => void; dispose: () => void } {
  const drawn = new Map<IMarker, { decoration: IDecoration; label: string }>()
  // Where the last scan stopped; a marker too, so trimmed scrollback moves it. Disposed, everything is new.
  let scanned: IMarker | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let whole = false

  const forget = (marker: IMarker): void => {
    drawn.get(marker)?.decoration.dispose()
    drawn.delete(marker)
    marker.dispose()
  }

  const run = (): void => {
    timer = null
    const buffer = term.buffer.active
    if (buffer.type !== 'normal') return
    const cursor = buffer.baseY + buffer.cursorY
    // A program can rewrite any line on its screen, so the screen above the last stop is read again.
    const from = whole || scanned === undefined || scanned.isDisposed ? 0 : scanned.line - term.rows
    whole = false
    scanned?.dispose()
    scanned = term.registerMarker(0)

    // A rule whose line no longer says it, overwritten or cleared, goes.
    const taken = new Map<number, string>()
    for (const [marker, { label }] of drawn) {
      if (marker.line >= from && labelAt(buffer, marker.line) !== label) forget(marker)
      else taken.set(marker.line, label)
    }
    for (const { line, label } of markerRows(buffer, from, buffer.length)) {
      if (taken.get(line) === label) continue
      const marker = term.registerMarker(line - cursor)
      if (marker === undefined) continue
      const decoration = term.registerDecoration({ marker, width: term.cols, layer: 'top' })
      if (decoration === undefined) {
        marker.dispose()
        continue
      }
      decoration.onRender((element) => drawRule(term, element, label))
      drawn.set(marker, { decoration, label })
      marker.onDispose(() => {
        drawn.get(marker)?.decoration.dispose()
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
      scanned?.dispose()
      for (const marker of [...drawn.keys()]) forget(marker)
    }
  }
}

/**
 * The rule goes inside xterm's decoration element, whose place, size and `display` (none off the screen
 * and on the alternate one) are xterm's; overriding that display left a rule floating over live output.
 */
function drawRule(term: Terminal, element: HTMLElement, label: string): void {
  // Its width in cells is fixed when registered; the screen's, read at each render, follows a resize.
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (screen) element.style.width = `${screen.clientWidth}px`
  if (element.firstElementChild !== null) return
  element.classList.add('pane-marker-row')
  const rule = element.ownerDocument.createElement('div')
  rule.className = 'pane-marker'
  rule.textContent = label
  element.append(rule)
}
