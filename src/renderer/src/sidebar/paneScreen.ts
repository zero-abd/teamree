// What a pane's screen says, read through a terminal emulator: agents draw by moving the cursor
// between rows, which a line replay turns into one scrambled line.

import { Terminal as Emulator } from '@xterm/xterm'
import type { Terminal } from '@shared/entities'
import { evidenceInRows } from '@shared/outputEvidence'
import { screenQuestion } from '@shared/screenOpinion'
import { bufferRows, type PaneScreen } from '../terminal/shownPanes'

/** Rows handed to the line picker; it looks no further back than this anyway. */
export const SCREEN_ROWS_READ = 200

/** The screen `output` leaves on a terminal of this size, rebuilt by an emulator that is never drawn. */
export async function replayScreen(output: string, cols: number, rows: number): Promise<PaneScreen> {
  const emulator = new Emulator({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: SCREEN_ROWS_READ })
  try {
    await new Promise<void>((resolve) => emulator.write(output, resolve))
    const buffer = emulator.buffer.active
    return { rows: bufferRows(buffer, SCREEN_ROWS_READ), alternate: buffer.type === 'alternate' }
  } finally {
    emulator.dispose()
  }
}

/**
 * The line to quote from a pane's screen: the question, while an agent asks one. An agent's full-screen
 * transcript is read like any output; a shell's pager or editor is not, since one row of it means nothing.
 */
export function screenEvidence(
  screen: PaneScreen,
  terminal: Pick<Terminal, 'agent' | 'foregroundAgent'>
): string | null {
  const question = screenQuestion(terminal.agent ?? terminal.foregroundAgent, screen.rows)
  if (question !== null) return question
  if (screen.alternate && terminal.agent === undefined) return null
  return evidenceInRows(screen.rows)
}
