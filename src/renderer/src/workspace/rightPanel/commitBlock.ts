// A commit a hook refused, handed to the worktree's idle agent the way Send Failure to Agent hands it checks.

import { useWorkspaceStore, type CommitBlock } from '../../state/workspaceStore'
import { fenced, idleAgentPane, typeInto, type FailureOutcome } from './checkFailure'

export function commitBlockMessage(block: CommitBlock): string {
  return [`The ${block.hook} hook blocked the commit:`, fenced(block.output), 'Fix it and commit again.'].join('\n\n')
}

/** The first `count` lines the hook printed, for a glance. */
export function firstLines(block: CommitBlock, count: number): string[] {
  return block.output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, count)
}

export async function sendCommitBlock(worktreeId: string): Promise<FailureOutcome> {
  const state = useWorkspaceStore.getState()
  const block = state.commitBlocks[worktreeId]
  const target = idleAgentPane(state.terminals, worktreeId, state.layouts[worktreeId]?.focusedTerminalId ?? null)
  if (block === undefined || target === undefined) return 'refused'
  return typeInto(target.id, commitBlockMessage(block))
}
