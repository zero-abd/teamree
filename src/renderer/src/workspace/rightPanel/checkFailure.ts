// Send Failure to Agent: the failing checks' names and log tails, pasted into the worktree's idle agent the
// way a review comment is. Never into a shell, nor an agent that is working or asking.

import type { CheckFailure, Terminal, WorktreeLanding } from '@shared/entities'
import { activityOf } from '@shared/paneActivity'
import { agentTargets, pasted } from '../../review/reviewComments'
import { runtimeClient } from '../../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../../state/workspaceStore'

export const MAX_FAILURES_SENT = 3
/** Between the paste and its Return, so a prompt that times input bursts reads them as two. */
const PASTE_SETTLE_MS = 60

/** The worktree's agent pane that is running and quiet, the focused one first. */
export function idleAgentPane(
  terminals: Readonly<Record<string, Terminal>>,
  worktreeId: string,
  focusedId?: string | null
): Terminal | undefined {
  const idle = agentTargets(terminals, worktreeId).filter(
    (terminal) => terminal.draining !== true && activityOf(terminal) === 'quiet'
  )
  return idle.find((terminal) => terminal.id === focusedId) ?? idle[0]
}

export function failureMessage(pull: NonNullable<WorktreeLanding['pullRequest']>, failures: CheckFailure[]): string {
  const blocks = failures.map((failure) => {
    const head = failure.url === undefined ? failure.name : `${failure.name} ${failure.url}`
    if (failure.excerpt === '') return head
    const longest = Math.max(0, ...(failure.excerpt.match(/`+/g) ?? []).map((run) => run.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return [head, fence, failure.excerpt, fence].join('\n')
  })
  const names = failures.map((failure) => failure.name).join(', ')
  return [`PR #${pull.number} checks failed: ${names}`, ...blocks, 'Fix them and push.'].join('\n\n')
}

export type FailureOutcome = 'sent' | 'refused' | 'failed'

export async function sendCheckFailure(worktreeId: string): Promise<FailureOutcome> {
  const store = useWorkspaceStore.getState
  const pull = store().landings[worktreeId]?.pullRequest
  const failing = pull?.checks?.list.filter((check) => check.state === 'fail').slice(0, MAX_FAILURES_SENT) ?? []
  const focused = (): string | null => store().layouts[worktreeId]?.focusedTerminalId ?? null
  const target = idleAgentPane(store().terminals, worktreeId, focused())
  if (pull === undefined || failing.length === 0 || target === undefined) return 'refused'

  const failures = await Promise.all(
    failing.map((check) =>
      runtimeClient
        .call('worktree.checkFailure', { worktreeId, name: check.name })
        .catch(
          (): CheckFailure => ({ worktreeId, name: check.name, ...(check.url ? { url: check.url } : {}), excerpt: '' })
        )
    )
  )
  // The logs take a while; the agent may have been given something else to do meanwhile.
  const current = store().terminals[target.id]
  if (current === undefined || idleAgentPane({ [current.id]: current }, worktreeId) === undefined) return 'refused'
  try {
    await runtimeClient.call('terminal.write', { terminalId: target.id, data: pasted(failureMessage(pull, failures)) })
    await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
    await runtimeClient.call('terminal.write', { terminalId: target.id, data: '\r' })
    return 'sent'
  } catch {
    return 'failed'
  }
}
