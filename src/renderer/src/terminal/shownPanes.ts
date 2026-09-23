// The emulators on screen, by pane, so Copy Output copies the grid the pane shows rather than
// the raw stream, whose cursor moves only an emulator can replay.

type Buffer = {
  length: number
  getLine: (row: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined
}
type Shown = { buffer: { active: Buffer } }

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
  if (buffer === undefined) return null
  const lines: string[] = []
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (line === undefined) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  return lines.join('\n').trimEnd()
}
