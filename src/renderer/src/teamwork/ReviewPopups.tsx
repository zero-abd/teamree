// "<name> reviewed <task>" and "<name> asks you to review <task>" in the corner, one per unseen review or
// request, oldest first. Never takes the focus.

import { useReviewStore } from '../review/reviewStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { reviewPopups, useReceivedReviews } from './receivedReviewsStore'
import { requestPopups, reviewRequested, useReviewRequests } from './reviewRequestsStore'

export function ReviewPopups(): React.JSX.Element | null {
  const reviews = useReceivedReviews((state) => state.reviews)
  const settle = useReceivedReviews((state) => state.settle)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const requests = useReviewRequests((state) => state.byProject)
  const settleRequest = useReviewRequests((state) => state.settle)
  const popups = reviewPopups(reviews)
  const asked = requestPopups(requests)
  if (popups.length === 0 && asked.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {asked.map((request) => (
        <div className="notice notice--info task-review" key={request.id}>
          <span className="notice__text">
            {request.from ?? 'A teammate'} asks you to review <strong>{request.worktreeName}</strong>
          </span>
          <button type="button" className="notice__action" onClick={() => reviewRequested(request)}>
            Review
          </button>
          <button
            type="button"
            className="notice__action"
            onClick={() => void settleRequest(request.projectId, request.id, 'seen')}
          >
            Later
          </button>
        </div>
      ))}
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
