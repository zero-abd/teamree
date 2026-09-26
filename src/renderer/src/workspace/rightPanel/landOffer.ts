// Where a branch lands: a pull request on the host, which commits and pushes first, or a merge into the base (a child's parent) here.

import type { WorktreeLanding, WorktreeStatus } from '@shared/entities'
import type { PushState } from '../../state/workspaceStore'

/** `blocked` says why it cannot run yet (`1 conflicted`); `uncommitted` is what the dialog commits first. */
export type LandOffer =
  | { kind: 'create-pr'; uncommitted?: number; blocked?: string }
  | { kind: 'open-pr'; number: number; url: string }
  | { kind: 'merge'; into: string; parent?: boolean; uncommitted?: number; blocked?: string }
  | { kind: 'merged' }

/** What the branch can do next; null only when there is nothing to land. */
export function landOffer(landing: WorktreeLanding | undefined, status: WorktreeStatus | undefined): LandOffer | null {
  if (landing === undefined || status === undefined || status.missing) return null
  if (landing.merged) return { kind: 'merged' }
  const uncommitted = status.staged + status.unstaged + status.untracked + status.conflicted
  if (landing.parent !== undefined || landing.host === null) {
    const into = mergeTarget(landing)
    if (status.conflicted > 0) return { ...into, blocked: `${status.conflicted} conflicted` }
    if (uncommitted > 0) return { ...into, uncommitted }
    return landing.unmerged > 0 ? into : null
  }
  if (landing.pullRequest?.state === 'open') {
    return { kind: 'open-pr', number: landing.pullRequest.number, url: landing.pullRequest.url }
  }
  if (status.conflicted > 0) return { kind: 'create-pr', blocked: `${status.conflicted} conflicted` }
  if (uncommitted > 0) return { kind: 'create-pr', uncommitted }
  return landing.unmerged > 0 ? { kind: 'create-pr' } : null
}

/** The land a worktree with nothing to land would make, blocked, so the palette still names it. */
export function idleLand(landing: WorktreeLanding | undefined): LandOffer | null {
  if (landing === undefined) return null
  if (landing.parent === undefined && landing.host !== null) return { kind: 'create-pr', blocked: 'nothing to land' }
  return { ...mergeTarget(landing), blocked: 'nothing to land' }
}

function mergeTarget(landing: WorktreeLanding): { kind: 'merge'; into: string; parent?: boolean } {
  return landing.parent === undefined
    ? { kind: 'merge', into: landing.base }
    : { kind: 'merge', into: landing.parent.name, parent: true }
}

/** The offer's button, as the Changes header and the palette name it. */
export function landLabel(offer: Exclude<LandOffer, { kind: 'merged' }>): string {
  switch (offer.kind) {
    case 'create-pr':
      return offer.uncommitted === undefined ? 'Create Pull Request…' : 'Commit & Create Pull Request…'
    case 'open-pr':
      return `Open Pull Request #${offer.number}`
    case 'merge':
      return `${offer.uncommitted === undefined ? '' : 'Commit & '}Merge into ${offer.parent ? 'Parent' : offer.into}…`
  }
}

/** The button's tooltip: the note, after the parent's full name that the label leaves out. */
export function landTitle(offer: Exclude<LandOffer, { kind: 'merged' }>): string | undefined {
  const named = offer.kind === 'merge' && offer.parent ? `Merge into ${offer.into}` : undefined
  return [named, landNote(offer)].filter(Boolean).join(' · ') || undefined
}

/** Why the offer cannot run, or what running it commits first. */
export function landNote(offer: Exclude<LandOffer, { kind: 'merged' }>): string | undefined {
  if (offer.kind === 'open-pr') return undefined
  if (offer.uncommitted !== undefined) return `${offer.uncommitted} uncommitted`
  return offer.blocked
}

export type PushOffer = { kind: 'push' | 'publish' } | { kind: 'review'; url: string }

/** Send commits the remote lacks, else open the review the last push made; nothing without a remote. */
export function pushOffer(
  status: WorktreeStatus | undefined,
  push: PushState | undefined,
  remote = true
): PushOffer | null {
  if (!status || status.missing || !remote) return null
  // Without a commit, a published branch would be its base under another name.
  if (status.upstream === null) return status.ahead > 0 || push?.phase === 'pushing' ? { kind: 'publish' } : null
  if (status.ahead > 0 || push?.phase === 'pushing') return { kind: 'push' }
  if (push?.phase === 'pushed' && push.reviewUrl !== undefined) return { kind: 'review', url: push.reviewUrl }
  return null
}

export type HeaderAction =
  | { kind: 'land'; offer: Exclude<LandOffer, { kind: 'merged' }> }
  | { kind: 'push'; offer: PushOffer }
  | { kind: 'update'; from: string }

/** The Changes header: one action on screen, primary when it is the next step, the rest in its menu. */
export function headerActions(input: {
  land: LandOffer | null
  push: PushOffer | null
  updateFrom: string | null
  uncommitted: boolean
  ahead: number
}): { shown: HeaderAction | null; primary: boolean; more: HeaderAction[] } {
  const land = input.land === null || input.land.kind === 'merged' ? null : input.land
  // A pull request button is the review page, and more.
  const push = input.push?.kind === 'review' && land !== null ? null : input.push
  // Commit what is uncommitted first, then send it, then land it; a merge or a new pull request sends it itself.
  const pushNext = push !== null && !input.uncommitted && input.ahead > 0 && (land === null || land.kind === 'open-pr')
  const pushed: HeaderAction[] = push === null ? [] : [{ kind: 'push', offer: push }]
  const actions: HeaderAction[] = [
    ...(pushNext ? pushed : []),
    ...(land === null ? [] : [{ kind: 'land' as const, offer: land }]),
    ...(pushNext ? [] : pushed),
    ...(input.updateFrom === null ? [] : [{ kind: 'update' as const, from: input.updateFrom }])
  ]
  const [shown = null, ...more] = actions
  const primary =
    shown?.kind === 'push'
      ? pushNext
      : shown?.kind === 'land' && !input.uncommitted && landNote(shown.offer) === undefined
  return { shown, primary, more }
}
