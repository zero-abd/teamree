// One line under the lines picked: a comment, sent to the worktree's agent pane or kept for a batch.

import { useMemo, useState } from 'react'
import type { Terminal } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { paneAgent, paneNamesById, truncateName } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { agentTargets, lineRef, type QuotedLine, type ReviewComment } from './reviewComments'
import { useReviewStore } from './reviewStore'

export function CommentComposer({
  worktreeId,
  path,
  lines,
  onClose
}: {
  worktreeId: string
  path: string
  lines: readonly QuotedLine[]
  onClose: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [failed, setFailed] = useState(false)
  const comment: ReviewComment = { path, lines: [...lines], note }
  const { targets, names, target, choose } = useAgentTarget(worktreeId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const send = useReviewStore((state) => state.send)
  const addToBatch = useReviewStore((state) => state.addToBatch)
  const ready = note.trim() !== ''

  const submit = async (go: boolean): Promise<void> => {
    if (!ready || target === undefined) return
    const outcome = await send(target.id, [comment])
    if (outcome === 'failed' || outcome === 'refused') {
      setFailed(true)
      return
    }
    onClose()
    if (go) focusPane(target.id)
  }

  const batch = (): void => {
    if (!ready) return
    addToBatch(worktreeId, comment)
    onClose()
  }

  return (
    <div className="comment" role="group" aria-label={`Comment on ${lineRef(comment)}`}>
      <span className="comment__ref">{lineRef(comment)}</span>
      <input
        className="comment__field"
        type="text"
        value={note}
        placeholder="Comment"
        aria-label="Comment"
        autoFocus
        onChange={(event) => {
          setNote(event.target.value)
          setFailed(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            // ⌘Return goes to the pane as well; plain Return stays in review.
            void submit(event.metaKey || event.ctrlKey)
          }
        }}
      />
      {failed ? <span className="comment__failed">Not sent</span> : null}
      <AgentPicker targets={targets} names={names} value={target?.id} onChange={choose} />
      <button
        type="button"
        className="button button--primary button--small comment__send"
        disabled={!ready || target === undefined}
        title={target === undefined ? 'No agent pane in this worktree' : undefined}
        onClick={() => void submit(false)}
      >
        {target === undefined || targets.length > 1 ? 'Send' : `Send to ${agentName(target)}`}
      </button>
      <button type="button" className="button button--small" disabled={!ready} onClick={batch}>
        Add to Batch
      </button>
    </div>
  )
}

/** The worktree's agent panes by name, and the one comments go to: the first unless another is picked. */
export function useAgentTarget(worktreeId: string): {
  targets: ReturnType<typeof agentTargets>
  names: Record<string, string>
  target: ReturnType<typeof agentTargets>[number] | undefined
  choose: (terminalId: string) => void
} {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const [chosen, choose] = useState<string | null>(null)
  const targets = useMemo(() => agentTargets(terminals, worktreeId), [terminals, worktreeId])
  const names = useMemo(
    () =>
      paneNamesById(
        Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId),
        worktree
      ),
    [terminals, worktreeId, worktree]
  )
  return { targets, names, target: targets.find((terminal) => terminal.id === chosen) ?? targets[0], choose }
}

/** The agent a pane runs, by its product name; a pane's own name can be a whole task. */
function agentName(terminal: Terminal): string {
  const kind = paneAgent(terminal)
  return kind === undefined ? '' : harnessName(kind)
}

/** The agent pane comments go to: its glyph, or a choice when there are several. */
export function AgentPicker({
  targets,
  names,
  value,
  onChange
}: {
  targets: ReturnType<typeof agentTargets>
  names: Record<string, string>
  value: string | undefined
  onChange: (terminalId: string) => void
}): React.JSX.Element | null {
  const agent = targets.find((terminal) => terminal.id === value)
  const kind = agent === undefined ? undefined : paneAgent(agent)
  if (targets.length === 0) return null
  if (targets.length === 1) return kind === undefined ? null : <AgentGlyph kind={kind} decorative />
  return (
    <span className="comment__agent">
      {kind === undefined ? null : <AgentGlyph kind={kind} decorative />}
      <select aria-label="Agent pane" value={value} onChange={(event) => onChange(event.target.value)}>
        {targets.map((terminal) => (
          <option key={terminal.id} value={terminal.id}>
            {truncateName(names[terminal.id] ?? agentName(terminal))}
          </option>
        ))}
      </select>
    </span>
  )
}
