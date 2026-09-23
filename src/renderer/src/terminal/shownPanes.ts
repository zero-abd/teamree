// The emulators on screen, by pane, so Copy Output copies the grid the pane shows rather than
// the raw stream, whose cursor moves only an emulator can replay.

type Buffer = {
  type?: 'normal' | 'alternate'
  length: number
  getLine: (row: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined
}
type Shown = { buffer: { active: Buffer } }

/** An emulator's rows as lines, and whether a full-screen program has the alternate screen. */
export type PaneScreen = { rows: string[]; alternate: boolean }

const shown = new Map<string, Shown>()

/** Registers a mounted emulator; the returned function unregisters that one only. */
export function showPane(terminalId: string, term: Shown): () => void {
  shown.set(terminalId, term)
  return () => {
    if (shown.get(terminalId) === term) shown.delete(terminalId)
  }
}

/** The pane's scrollback and screen as text, wrapped rows joined; null when it is not mounted. */
export function shownText(terminalId: string): string | null {
  const buffer = shown.get(terminalId)?.buffer.active
  return buffer === undefined ? null : bufferRows(buffer).join('\n').trimEnd()
}

/** The last `limit` rows of a mounted pane's screen; null when it is not mounted. */
export function shownScreen(terminalId: string, limit?: number): PaneScreen | null {
  const buffer = shown.get(terminalId)?.buffer.active
  return buffer === undefined ? null : { rows: bufferRows(buffer, limit), alternate: buffer.type === 'alternate' }
}

/** The last `limit` rows as lines, wrapped rows joined, blank rows under the last written one dropped. */
export function bufferRows(buffer: Buffer, limit: number = buffer.length): string[] {
  const lines: string[] = []
  for (let row = Math.max(0, buffer.length - limit); row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (line === undefined) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  return lines
}
