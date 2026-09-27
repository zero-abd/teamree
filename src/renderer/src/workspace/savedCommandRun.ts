// Where a saved command goes: a shell one into a new pane or the focused shell, a prompt into the
// worktree's agent (pasted, then Return), a new agent pane, or the New Task sheet.

import type { SavedCommand, Terminal } from '@shared/entities'
import { defaultAgentKind } from '../dialogs/taskPlan'
import { agentTargets, pasted } from '../review/reviewComments'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { paneAgent } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Between the paste and its Return, so a prompt that times input bursts reads them as two. */
const PASTE_SETTLE_MS = 60

export async function startSavedCommand(worktreeId: string, command: SavedCommand): Promise<void> {
  const store = useWorkspaceStore.getState
  const worktree = store().worktrees.find((entry) => entry.id === worktreeId)
  if (worktree === undefined) return
  if (command.kind === 'agent' && command.where === 'task') {
    store().openDialog({ kind: 'new-task', projectId: worktree.projectId, task: command.text })
    return
  }
  if (store().activeWorktreeId !== worktreeId) await store().openWorktree(worktreeId)
  const focused = store().layouts[worktreeId]?.focusedTerminalId ?? null
  const write = (terminalId: string, data: string): Promise<unknown> =>
    runtimeClient.call('terminal.write', { terminalId, data })

  try {
    if (command.kind === 'shell') {
      const shell = command.where === 'current' ? shellPane(store().terminals, focused) : undefined
      if (shell === undefined) {
        await store().createTerminal(worktreeId, { command: command.text, label: command.label })
        return
      }
      await write(shell.id, `${command.text}\r`)
      store().focusPane(shell.id)
      return
    }
    const targets = command.where === 'current' ? agentTargets(store().terminals, worktreeId) : []
    const agent = targets.find((terminal) => terminal.id === focused) ?? targets[0]
    if (agent !== undefined) {
      await write(agent.id, pasted(command.text))
      await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
      await write(agent.id, '\r')
      store().focusPane(agent.id)
      return
    }
    const { agents, defaultAgent } = store()
    const chosen =
      agents.find((entry) => entry.kind === command.agent) ??
      agents.find((entry) => entry.kind === defaultAgentKind(agents, defaultAgent))
    if (chosen === undefined) store().showNotice('No agent found', 'error')
    else await store().startAgent(chosen.command, command.text)
  } catch (error) {
    store().showNotice(
      `Could not run ${command.label}: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    )
  }
}

/** The focused pane when a typed line would reach its shell: running, and no agent or Run command in front. */
function shellPane(terminals: Readonly<Record<string, Terminal>>, focused: string | null): Terminal | undefined {
  const pane = focused === null ? undefined : terminals[focused]
  if (pane === undefined || !pane.running || pane.draining === true || pane.run !== undefined) return undefined
  return paneAgent(pane) === undefined ? pane : undefined
}
