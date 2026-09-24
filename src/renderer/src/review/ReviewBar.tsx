// The Changes panel's review line: Review All, the batched comments' Send, and panes holding unsent comments.

import { activityOf } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AgentPicker, useAgentTarget } from './CommentComposer'
import { useReviewStore } from './reviewStore'

export function ReviewBar({ worktreeId, changed }: { worktreeId: string; changed: boolean }): React.JSX.Element | null {
  const openReview = useWorkspaceStore((state) => state.openReview)
  const count = useReviewStore((state) => state.batch[worktreeId]?.length ?? 0)
  const queued = useReviewStore((state) => state.queued)
  const sendBatch = useReviewStore((state) => state.sendBatch)
  const clearBatch = useReviewStore((state) => state.clearBatch)
  const sendQueued = useReviewStore((state) => state.sendQueued)
  const { targets, names, target, choose } = useAgentTarget(worktreeId)
  const waiting = targets.filter((terminal) => queued[terminal.id])
  if (!changed && count === 0 && waiting.length === 0) return null

  return (
    <div className="changes__review">
      {changed ? (
        <button type="button" className="button button--small" onClick={() => openReview(worktreeId)}>
          Review All
        </button>
      ) : null}
      {count > 0 ? (
        <>
          <AgentPicker targets={targets} names={names} value={target?.id} onChange={choose} />
          <button
            type="button"
            className="button button--small"
            disabled={target === undefined}
            title={target === undefined ? 'No agent pane in this worktree' : `To ${names[target.id] ?? ''}`}
            onClick={() => {
              if (target !== undefined) void sendBatch(worktreeId, target.id)
            }}
          >
            Send {count} {count === 1 ? 'Comment' : 'Comments'}
          </button>
          <button
            type="button"
            className="changes__clear"
            aria-label="Clear Comments"
            title="Clear Comments"
            onClick={() => clearBatch(worktreeId)}
          >
            ×
          </button>
        </>
      ) : null}
      {waiting.map((terminal) =>
        activityOf(terminal) === 'working' ? (
          <span key={terminal.id} className="changes__queued" title={`Typed into ${names[terminal.id] ?? ''}`}>
            Queued
          </span>
        ) : (
          <button
            key={terminal.id}
            type="button"
            className="button button--small"
            title={`Return in ${names[terminal.id] ?? ''}`}
            onClick={() => void sendQueued(terminal.id)}
          >
            Send Queued
          </button>
        )
      )}
    </div>
  )
}
