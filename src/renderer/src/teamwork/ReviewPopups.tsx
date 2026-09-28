// "<name> reviewed <task>" in the corner, one per unseen review, oldest first. Never takes the focus.

import { useReviewStore } from '../review/reviewStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { reviewPopups, useReceivedReviews } from './receivedReviewsStore'

export function ReviewPopups(): React.JSX.Element | null {
  const reviews = useReceivedReviews((state) => state.reviews)
  const settle = useReceivedReviews((state) => state.settle)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const popups = reviewPopups(reviews)
  if (popups.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {popups.map((review) => (
        <div className="notice notice--info task-review" key={review.id}>
          <span className="notice__text">
            {review.handle} reviewed{' '}
            <strong>{worktrees.find((worktree) => worktree.id === review.worktreeId)?.name ?? 'a task'}</strong>
          </span>
          <button
            type="button"
            className="notice__action"
            onClick={() => {
              void settle(review.id, 'seen')
              useReviewStore.getState().reviewBranch(review.worktreeId)
            }}
          >
            Open
          </button>
          <button type="button" className="notice__action" onClick={() => void settle(review.id, 'seen')}>
            Later
          </button>
        </div>
      ))}
    </div>
  )
}
