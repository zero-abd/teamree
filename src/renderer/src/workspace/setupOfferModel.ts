// Which setup offer, if any, sits across the top of a worktree: the project's suggested
// command until it is used or put off, then Run for a checkout that lacks its dependencies.

import type { Project, Worktree, WorktreeSetupCheck } from '@shared/entities'

export type SetupOffer = { kind: 'project'; command: string } | { kind: 'worktree'; command: string; missing: string }

export function setupOfferFor(input: {
  project: Project
  worktree: Worktree
  check: WorktreeSetupCheck
  /** Not now was pressed on this project's suggestion. */
  dismissed: boolean
  /** Not now was pressed on this worktree's Run. */
  skipped: boolean
}): SetupOffer | null {
  const { project, worktree, check } = input
  if (worktree.setupAsk !== undefined) return null
  const command = project.setupCommand ?? project.repository?.setupCommand
  if (command === undefined && project.suggestedSetup !== undefined && !input.dismissed) {
    return { kind: 'project', command: project.suggestedSetup }
  }
  const run = command ?? check.command
  if (check.missing === undefined || run === undefined || input.skipped) return null
  if (worktree.setupTerminalId !== undefined) return null
  return { kind: 'worktree', command: run, missing: check.missing }
}

const DISMISSED_KEY = 'teamree.setup.dismissed'

/** Projects whose suggestion got Not now, from this window's storage. */
export function readDismissed(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function writeDismissed(storage: Pick<Storage, 'setItem'> | undefined, projectIds: readonly string[]): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify(projectIds))
  } catch {
    // Unavailable storage: the offer comes back next launch.
  }
}
