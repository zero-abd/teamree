// The step after Publish: a pull request on the host, or a merge into the base here, then Done.

import type { WorktreeLanding, WorktreeStatus } from '@shared/entities'

export type LandOffer =
  | { kind: 'create-pr' }
  | { kind: 'open-pr'; number: number; url: string }
  | { kind: 'merge'; into: string }
  | { kind: 'merged' }

/** What the finished branch can do next; null while there is still something to commit or push first. */
export function landOffer(landing: WorktreeLanding | undefined, status: WorktreeStatus | undefined): LandOffer | null {
  if (landing === undefined || status === undefined || status.missing) return null
  if (landing.merged) return { kind: 'merged' }
  if (status.staged + status.unstaged + status.untracked + status.conflicted > 0) return null
  if (landing.host === null) return landing.unmerged > 0 ? { kind: 'merge', into: landing.base } : null
  if (landing.pullRequest?.state === 'open') {
    return { kind: 'open-pr', number: landing.pullRequest.number, url: landing.pullRequest.url }
  }
  return landing.published && status.ahead === 0 && landing.unmerged > 0 ? { kind: 'create-pr' } : null
}

/** The offer's button, as the Changes header and the palette name it. */
export function landLabel(offer: Exclude<LandOffer, { kind: 'merged' }>): string {
  switch (offer.kind) {
    case 'create-pr':
      return 'Create Pull Request'
    case 'open-pr':
      return `Open Pull Request #${offer.number}`
    case 'merge':
      return `Merge into ${offer.into}…`
  }
}
