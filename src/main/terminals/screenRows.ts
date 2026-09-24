// The rows a pane's output leaves on screen. Agents lay words out by moving the
// cursor, so only an emulator can tell what is still showing.

/** The visible rows `output` leaves on a terminal of this size, right-trimmed. */
export async function screenRows(output: string, cols: number, rows: number): Promise<string[]> {
  // Loaded on the first read, so an app with no agent pane never parses it.
  const { Terminal: Emulator } = await import('@xterm/xterm')
  const emulator = new Emulator({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: 0 })
  try {
    await new Promise<void>((resolve) => emulator.write(output, resolve))
    const buffer = emulator.buffer.active
    const screen: string[] = []
    for (let row = buffer.baseY; row < buffer.baseY + emulator.rows; row++) {
      screen.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return screen
  } finally {
    emulator.dispose()
  }
}
