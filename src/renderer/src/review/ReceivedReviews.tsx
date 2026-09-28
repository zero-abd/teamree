// Teammates' comments on this task, above its review: each one's lines and note, sent to the agent in one go.

import { useReceivedReviews } from '../teamwork/receivedReviewsStore'
import { Button, IconButton } from '../ui/Button'
import { AgentPicker, useAgentTarget } from './CommentComposer'
import { lineRef } from './reviewComments'
import { useReviewStore } from './reviewStore'

export function ReceivedReviews({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const reviews = useReceivedReviews((state) => state.reviews)
  const settle = useReceivedReviews((state) => state.settle)
  const send = useReviewStore((state) => state.send)
  const { targets, names, target, choose } = useAgentTarget(worktreeId)
  const mine = reviews.filter((review) => review.worktreeId === worktreeId)
  if (mine.length === 0) return null
  return (
    <div className="review__received">
      {mine.map((review) => (
        <section key={review.id} className="review__from" aria-label={`${review.handle}’s review`}>
          <header className="review__fromHead">
            <strong>{review.handle}</strong>
            <span>{`${review.comments.length} ${review.comments.length === 1 ? 'comment' : 'comments'}`}</span>
            <span className="file__spacer" />
            <AgentPicker targets={targets} names={names} value={target?.id} onChange={choose} />
            <Button
              size="sm"
              disabled={target === undefined}
              onClick={() => {
                if (target === undefined) return
                void send(target.id, review.comments).then((outcome) => {
                  if (outcome === 'sent' || outcome === 'queued') void settle(review.id, 'closed')
                })
              }}
            >
              Send to Agent
            </Button>
            <IconButton
              icon="close"
              size="sm"
              label="Dismiss Review"
              onClick={() => void settle(review.id, 'closed')}
            />
          </header>
          <ul className="review__batch">
            {review.comments.map((comment, index) => (
              <li key={`${lineRef(comment)}-${index}`} className="review__batched">
                <span className="comment__ref">{lineRef(comment)}</span>
                <span className="review__note">{comment.note}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
