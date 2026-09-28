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
    return failure.excerpt === '' ? head : `${head}\n${fenced(failure.excerpt)}`
  })
  const names = failures.map((failure) => failure.name).join(', ')
  return [`PR #${pull.number} checks failed: ${names}`, ...blocks, 'Fix them and push.'].join('\n\n')
}

/** `text` in a code fence longer than any backtick run inside it. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, text, fence].join('\n')
}

export type FailureOutcome = 'sent' | 'refused' | 'failed'

/** Pastes `message` into the pane and submits it. */
export async function typeInto(terminalId: string, message: string): Promise<FailureOutcome> {
  try {
    await runtimeClient.call('terminal.write', { terminalId, data: pasted(message) })
    await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
    await runtimeClient.call('terminal.write', { terminalId, data: '\r' })
    return 'sent'
  } catch {
    return 'failed'
  }
}

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
  return typeInto(target.id, failureMessage(pull, failures))
}
