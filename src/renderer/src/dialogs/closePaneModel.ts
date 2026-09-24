// Whether closing a pane is worth a confirmation, and what it says. Only where the click destroys
// something: `busy` output, or an agent working or asking; a quiet agent closes like a shell at a prompt.
// Never once `running` is false or while `draining`.

import type { Terminal } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { activityOf, askingLine, paneName } from '../sidebar/agentRows'

export type ClosePaneWarning = {
  /** The question, as the dialog's title. */
  title: string
  /** What is actually there: the pane's line, as its sidebar row quotes it. */
  body?: string
  /** The button that goes through with it. Names the act, never "OK". */
  confirm: string
}

/** What to ask before closing this pane, or null to close without asking (unknown terminals included). */
export function closePaneWarning(terminal: Terminal | undefined, line: string | null = null): ClosePaneWarning | null {
  if (terminal === undefined) return null
  if (!terminal.running || terminal.draining === true) return null

  if (terminal.agent !== undefined) {
    const activity = activityOf(terminal)
    if (activity !== 'working' && activity !== 'waiting') return null
    const body = activity === 'waiting' ? askingLine(line, terminal.agentEvent) : line
    return {
      title: `Stop ${harnessName(terminal.agent)}?`,
      ...(body === null ? {} : { body }),
      confirm: 'Stop and Close'
    }
  }

  if (terminal.busy) {
    return {
      title: 'Stop what is running here?',
      // The tab's name, not the program's title; never empty.
      body: `Output still arriving in “${paneName(terminal)}”`,
      confirm: 'Stop and Close'
    }
  }

  return null
}
