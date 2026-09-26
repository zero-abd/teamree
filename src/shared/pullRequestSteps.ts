// A pull request in one step: commit what is uncommitted, send the branch, then create it on the host.
// Shared by the dialog and `teamree worktree pr`; a failed step is retried from itself.

export type PullRequestStep = 'commit' | 'push' | 'create'

export type PullRequestStepFailure = { step: PullRequestStep; reason: string }

/** What the branch still needs before the host can have its pull request, in order. */
export function pullRequestSteps(at: { uncommitted: number; published: boolean; ahead: number }): PullRequestStep[] {
  const commit = at.uncommitted > 0
  const push = commit || !at.published || at.ahead > 0
  return [...(commit ? (['commit'] as const) : []), ...(push ? (['push'] as const) : []), 'create']
}

/** Runs `steps` from `from` (the first by default) and stops at the first that throws; null when all ran. */
export async function runPullRequestSteps(
  steps: readonly PullRequestStep[],
  run: (step: PullRequestStep) => Promise<void>,
  onStart?: (step: PullRequestStep) => void,
  from?: PullRequestStep
): Promise<PullRequestStepFailure | null> {
  for (const step of steps.slice(Math.max(0, from === undefined ? 0 : steps.indexOf(from)))) {
    onStart?.(step)
    try {
      await run(step)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { step, reason: text.split('\n').find((line) => line.trim() !== '') ?? text }
    }
  }
  return null
}
