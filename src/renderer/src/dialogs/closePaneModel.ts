// Whether closing a pane is worth a confirmation, and what it says. Only where the click destroys
// something: `busy` output, or an agent pane gone quiet (silence may be a question waiting).
// Never once `running` is false or while `draining`; a shell at a prompt closes without a word.

import type { Terminal } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { paneName } from '../sidebar/agentRows'

export type ClosePaneWarning = {
  /** The question, as the dialog's title. */
  title: string
  /** What is actually there, and what pressing through will cost. */
  body: string
  /** The button that goes through with it. Names the act, never "OK". */
  confirm: string
}

/** What to ask before closing this pane, or null to close without asking (unknown terminals included). */
export function closePaneWarning(terminal: Terminal | undefined): ClosePaneWarning | null {
  if (terminal === undefined) return null
  if (!terminal.running || terminal.draining === true) return null

  // The tab's name, not the program's title; never empty.
  const where = `“${paneName(terminal)}”`

  if (terminal.agent !== undefined) {
    return {
      title: 'Stop this agent?',
      // Working loses the work in flight; quiet may be holding a question, which this cannot tell from done.
      body: terminal.busy
        ? `${harnessName(terminal.agent)} is working in ${where}. Closing the pane kills it.`
        : `${harnessName(terminal.agent)} has gone quiet in ${where} — waiting for an answer, or finished. Closing the pane kills it.`,
      confirm: 'Stop it and close'
    }
  }

  if (terminal.busy) {
    return {
      title: 'Stop what is running here?',
      body: `Output is still arriving in ${where}. Closing the pane kills the process.`,
      confirm: 'Stop it and close'
    }
  }

  return null
}
