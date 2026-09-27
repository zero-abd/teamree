// The question a quit or Restart to Update asks while agents are mid-turn, since every pane dies
// with the app. Pure but for the timer: `index.ts` shows the question and acts on the answer.

import type { Terminal } from '../shared/entities'
import { activityOf } from '../shared/paneActivity'

/** `kept`: panes the quit leaves running in the pane host. */
export type BusyAgents = { working: number; asking: number; names: string[]; kept?: number }

/** Agent panes mid-turn or asking, named by `nameOf`, in the order given. */
export function busyAgents(terminals: readonly Terminal[], nameOf: (terminal: Terminal) => string): BusyAgents {
  const busy: BusyAgents = { working: 0, asking: 0, names: [] }
  for (const terminal of terminals) {
    if ((terminal.agent ?? terminal.foregroundAgent) === undefined) continue
    const activity = activityOf(terminal)
    if (activity === 'working') busy.working += 1
    else if (activity === 'waiting') busy.asking += 1
    else continue
    busy.names.push(nameOf(terminal))
  }
  return busy
}

const agents = (count: number): string => `${count} ${count === 1 ? 'agent is' : 'agents are'}`

export function busyLine({ working, asking }: BusyAgents): string {
  if (working === 0) return `${agents(asking)} asking`
  return asking === 0 ? `${agents(working)} working` : `${agents(working)} working, ${asking} asking`
}

/** What a restart is: asked for, asked for now, or waiting for idle; null for a plain quit. */
export type RestartIntent = 'asked' | 'now' | 'when-idle' | null

export type QuitQuestion = {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

const MOST_NAMED = 6

/** The native message box, or null when no agent is busy. */
export function quitQuestion(kind: 'quit' | 'restart', busy: BusyAgents): QuitQuestion | null {
  if (busy.working + busy.asking === 0) return null
  const named = busy.names.slice(0, MOST_NAMED)
  if (busy.names.length > MOST_NAMED) named.push(`+${busy.names.length - MOST_NAMED} more`)
  const buttons = kind === 'quit' ? ['Quit Anyway', 'Cancel'] : ['Restart When Idle', 'Restart Now', 'Cancel']
  const kept = busy.kept ?? 0
  const keeps = kept === 0 ? '' : `\n\n${kept === 1 ? '1 pane keeps' : `${kept} panes keep`} running`
  return {
    message: busyLine(busy),
    detail: named.join('\n') + keeps,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  }
}

/**
 * `go` lets the quit through; `quit-only` does too, dropping the restart that waits for idle;
 * `when-idle` starts that wait; `cancel` drops the restart that asked; `keep-waiting` keeps it.
 */
export type AgentsAnswer = 'go' | 'quit-only' | 'when-idle' | 'cancel' | 'keep-waiting'

export async function askAboutAgents(options: {
  intent: RestartIntent
  busy: BusyAgents
  /** Shows the question; resolves to the index of the button chosen. */
  show: (question: QuitQuestion) => Promise<number>
}): Promise<AgentsAnswer> {
  const { intent, busy, show } = options
  if (intent === 'now') return 'go'
  const question = quitQuestion(intent === 'asked' ? 'restart' : 'quit', busy)
  if (question === null) return 'go'
  const chosen = question.buttons[await show(question)]
  switch (chosen) {
    case 'Quit Anyway':
      return intent === 'when-idle' ? 'quit-only' : 'go'
    case 'Restart Now':
      return 'go'
    case 'Restart When Idle':
      return 'when-idle'
    default:
      return intent === 'when-idle' ? 'keep-waiting' : 'cancel'
  }
}

/**
 * Calls `onIdle` once no agent has been busy for two readings in a row, so an agent between
 * two tool calls is not read as done. Returns a stop.
 */
export function whenIdle(options: { busy: () => BusyAgents; onIdle: () => void; everyMs?: number }): () => void {
  let idleReadings = 0
  const timer = setInterval(() => {
    const busy = options.busy()
    idleReadings = busy.working + busy.asking === 0 ? idleReadings + 1 : 0
    if (idleReadings < 2) return
    clearInterval(timer)
    options.onIdle()
  }, options.everyMs ?? 2_000)
  return () => clearInterval(timer)
}
