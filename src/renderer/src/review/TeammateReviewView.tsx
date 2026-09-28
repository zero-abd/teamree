// A teammate's task read-only beside the workspace, as their panes are: their pushed branch, or the patch
// their machine sent, with comments batched here and sent back to them. Nothing is checked out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { teammatesHeard } from '@shared/entities'
import { parsePatch, type PatchFile } from '@shared/patch'
import type { TeammateDiff } from '@shared/teammateReview'
import { FileBar } from '../files/FileBar'
import { LayoutTools, ReadOnlyDiffBody, useWidth } from '../files/FileDiff'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button, IconButton } from '../ui/Button'
import { fitLayout, type CommentTarget, type PatchViewing } from '../workspace/PatchView'
import { lineRef, type ReviewComment } from './reviewComments'
import { isViewedFile, viewedMark } from './reviewModel'
import { useReviewStore } from './reviewStore'
import { useTeammateReview } from './teammateReviewStore'

export function TeammateReviewView({
  projectId,
  worktreeId: teammateWorktreeId,
  title: path,
  onClose
}: {
  projectId: string
  /** The teammate's worktree as `teamwork.presence` names it. */
  worktreeId: string
  title: string
  onClose: () => void
}): React.JSX.Element {
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const row = useWorkspaceStore((state) =>
    teammatesHeard(state.teammates[projectId])?.worktrees.find((entry) => entry.id === teammateWorktreeId)
  )
  const comments = useTeammateReview((state) => state.batch[teammateWorktreeId] ?? NONE)
  const add = useTeammateReview((state) => state.add)
  const remove = useTeammateReview((state) => state.remove)
  const clear = useTeammateReview((state) => state.clear)
  const send = useTeammateReview((state) => state.send)
  const viewed = useReviewStore((state) => state.viewed[teammateWorktreeId])
  const markViewed = useReviewStore((state) => state.markViewed)
  const [diff, setDiff] = useState<TeammateDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const width = useWidth(body, true)
  const layout = fitLayout(diffLayout, width)
  const handle = row?.handle ?? diff?.handle ?? ''

  const read = useCallback(() => {
    let alive = true
    setError(null)
    runtimeClient
      .call('teamwork.teammateDiff', { projectId, worktreeId: teammateWorktreeId })
      .then((next) => {
        if (alive) setDiff(next)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [projectId, teammateWorktreeId])
  useEffect(read, [read])

  const files = useMemo(() => (diff === null ? [] : parsePatch(diff.patch)), [diff])
  const viewing: PatchViewing = {
    viewed: (file) => isViewedFile(viewed?.[file.path], file),
    onViewed: (file, on) => markViewed(teammateWorktreeId, file.path, on ? viewedMark(file) : null)
  }
  const composeWith = (target: CommentTarget): React.ReactNode => (
    <TeammateComment
      target={target}
      onAdd={(comment) => add(teammateWorktreeId, comment)}
      onSend={(comment) => {
        add(teammateWorktreeId, comment)
        void send(projectId, teammateWorktreeId, handle)
      }}
    />
  )
  const sendAll = async (): Promise<void> => {
    setSending(true)
    await send(projectId, teammateWorktreeId, handle)
    setSending(false)
  }

  return (
    <section
      className="pane file review review--teammate"
      aria-label={path}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      <FileBar
        name={path}
        label={diff === null ? path : `${path} · ${summary(diff, files)}`}
        title={path}
        unsaved={false}
        onClose={onClose}
      >
        {comments.length === 0 ? null : (
          <>
            <Button variant="primary" size="sm" loading={sending} onClick={() => void sendAll()}>
              {`Send ${comments.length} to ${handle}`}
            </Button>
            <IconButton icon="close" size="sm" label="Clear Comments" onClick={() => clear(teammateWorktreeId)} />
          </>
        )}
        <IconButton icon="reload" size="sm" label="Read Again" onClick={() => void read()} />
        <LayoutTools layout={layout} bodyWidth={width} />
      </FileBar>
      <div className="file__body" ref={body}>
        <ReadOnlyDiffBody
          patch={diff?.patch ?? null}
          truncated={diff?.truncated ?? false}
          error={error}
          layout={layout}
          lead={
            <div className="review__head">
              <p className="review__task">{row?.task ?? row?.name ?? path}</p>
              {row?.report === undefined ? null : (
                <p className="review__said">
                  <span>{row.report.summary}</span>
                </p>
              )}
              {comments.length === 0 ? null : (
                <ul className="review__batch" aria-label="Comments to send">
                  {comments.map((comment, index) => (
                    <li key={`${lineRef(comment)}-${index}`} className="review__batched">
                      <span className="comment__ref">{lineRef(comment)}</span>
                      <span className="review__note">{comment.note}</span>
                      <IconButton
                        icon="close"
                        size="sm"
                        label="Remove Comment"
                        onClick={() => remove(teammateWorktreeId, index)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          }
          patchProps={{ composeWith, viewing }}
        />
      </div>
    </section>
  )
}

const NONE: ReviewComment[] = []

/** `origin/fix-footer · 3 files · +12 −2`, or `unpushed` for a patch their machine sent. */
function summary(diff: TeammateDiff, files: readonly PatchFile[]): string {
  let added = 0
  let removed = 0
  for (const line of files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  const source = diff.source === 'origin' ? `origin/${diff.branch}` : 'unpushed'
  return `${source} · ${files.length} ${files.length === 1 ? 'file' : 'files'} · +${added} −${removed}`
}

/** The line under picked lines of a teammate's patch: Return adds it to the batch, ⌘Return sends the batch. */
function TeammateComment({
  target,
  onAdd,
  onSend
}: {
  target: CommentTarget
  onAdd: (comment: ReviewComment) => void
  onSend: (comment: ReviewComment) => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const lines = target.lines.map(({ kind, text, oldNumber, newNumber }) => ({ kind, text, oldNumber, newNumber }))
  const comment: ReviewComment = { path: target.path, lines, note: note.trim() }
  const ready = comment.note !== ''
  const done = (go: (comment: ReviewComment) => void): void => {
    if (!ready) return
    go(comment)
    target.onClose()
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
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            target.onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            done(event.metaKey || event.ctrlKey ? onSend : onAdd)
          }
        }}
      />
      <Button variant="primary" size="sm" disabled={!ready} onClick={() => done(onAdd)}>
        Add
      </Button>
    </div>
  )
}
