// Which setup offer, if any, the rail shows for a worktree: the project's suggested command until it
// is used or put off, then Run for a checkout that lacks what a used or configured command installs.

import type { Project, Worktree, WorktreeSetupCheck } from '@shared/entities'

export type SetupOffer = { kind: 'project'; command: string } | { kind: 'worktree'; command: string; missing: string }

export function setupOfferFor(input: {
  project: Project
  worktree: Worktree
  check: WorktreeSetupCheck
  /** Not Now was pressed on this project's suggestion. */
  dismissed: boolean
  /** Not Now was pressed on this worktree's Run. */
  skipped: boolean
}): SetupOffer | null {
  const { project, worktree, check } = input
  if (worktree.setupAsk !== undefined) return null
  const command = project.setupCommand ?? project.repository?.setupCommand
  if (command === undefined && project.suggestedSetup !== undefined) {
    return input.dismissed ? null : { kind: 'project', command: project.suggestedSetup }
  }
  const run = command ?? check.command
  if (check.missing === undefined || run === undefined || input.skipped) return null
  if (worktree.setupTerminalId !== undefined) return null
  return { kind: 'worktree', command: run, missing: check.missing }
}

/** What a project's first task offers to set up for new worktrees: the detected command and ignored env files. */
export type FirstTaskSetup = { command?: string; copies: string[] }

export function firstTaskSetup(project: Project, hasWorktrees: boolean, dismissed: boolean): FirstTaskSetup | null {
  if (hasWorktrees || dismissed) return null
  const copies = project.suggestedCopies ?? []
  if (project.suggestedSetup === undefined && copies.length === 0) return null
  return { ...(project.suggestedSetup === undefined ? {} : { command: project.suggestedSetup }), copies }
}

const DISMISSED_KEY = 'teamree.setup.dismissed'

/** Projects whose suggestion got Not Now, from this window's storage. */
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

const OFFERED_KEY = 'teamree.setup.offeredOn'
/** A suggestion shows on this many of a project's worktrees; after that Settings and the project menu have it. */
const OFFERED_ON = 2

export type OfferedOn = Readonly<Record<string, readonly string[]>>

/** The record with this worktree in it, the same record if it was already, or null past the project's first two. */
export function offeredOn(record: OfferedOn, projectId: string, worktreeId: string): OfferedOn | null {
  const seen = record[projectId] ?? []
  if (seen.includes(worktreeId)) return record
  return seen.length >= OFFERED_ON ? null : { ...record, [projectId]: [...seen, worktreeId] }
}

export function readOfferedOn(storage: Pick<Storage, 'getItem'> | undefined): OfferedOn {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OFFERED_KEY) ?? '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as OfferedOn) : {}
  } catch {
    return {}
  }
}

export function writeOfferedOn(storage: Pick<Storage, 'setItem'> | undefined, record: OfferedOn): void {
  try {
    storage?.setItem(OFFERED_KEY, JSON.stringify(record))
  } catch {
    // Unavailable storage: the count starts again next launch.
  }
}
