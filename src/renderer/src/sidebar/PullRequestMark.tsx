// The pull request chip on a worktree row and a board row; a click opens the pull request.

import type { WorktreeLanding } from '@shared/entities'
import { openInBrowser } from '../shell/openInBrowser'
import { pullRequestChip } from './pullRequestChip'

export function PullRequestMark({
  pull
}: {
  pull: WorktreeLanding['pullRequest'] | undefined
}): React.JSX.Element | null {
  const chip = pullRequestChip(pull)
  if (chip === null || pull === undefined) return null
  // Inside the row's button, so a span: a nested link would open the row as well.
  return (
    <span
      className={`chip prchip prchip--${chip.tone}`}
      role="link"
      aria-label={chip.title.replace(/\n/g, ' · ')}
      data-tip={chip.title}
      onClick={(event) => {
        event.stopPropagation()
        openInBrowser(pull.url)
      }}
    >
      {chip.text}
    </span>
  )
}
