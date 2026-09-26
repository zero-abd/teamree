// Asked before a worktree's branch is merged into the base in the project's own checkout, or a child's
// into its parent's: the commits that go in, read fresh, and the files in the way when that checkout has uncommitted work.
// Work uncommitted in the worktree itself is committed first, under a message typed here, never left behind.

import { useEffect, useState } from 'react'
import type { WorktreeChanges, WorktreeMerge } from '@shared/entities'
import { useReviewStore } from '../review/reviewStore'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

const SHOWN = 5

export function ConfirmMergeDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const landing = useWorkspaceStore((state) => state.landings[worktreeId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const mergeIntoBase = useWorkspaceStore((state) => state.mergeIntoBase)
  const pending = useWorkspaceStore((state) => state.changes[worktreeId])
  const status = useWorkspaceStore((state) => state.statuses[worktreeId])
  const [message, setMessage] = useState('')
  const reviewBranch = useReviewStore((state) => state.reviewBranch)
  const [plan, setPlan] = useState<WorktreeMerge | null>(null)
  const [branch, setBranch] = useState<WorktreeChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.mergeIntoBase', { worktreeId, dryRun: true })
      .then((read) => {
        if (alive) setPlan(read)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    runtimeClient
      .call('worktree.changes', { worktreeId, base: true })
      .then((read) => {
        if (alive) setBranch(read)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId])

  const into = landing?.parent?.name ?? plan?.into ?? landing?.base ?? 'main'
  const name = worktree === undefined ? 'this worktree' : `"${worktreeLabel(worktreeDisplay(worktree))}"`
  const dirty = plan?.dirty ?? []
  const commits = (plan?.commits ?? []).map((commit) => `${commit.shortSha} ${commit.subject}`)
  const uncommitted = pending?.changes.map((change) => change.path) ?? []
  const counted = status === undefined ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted
  // The list stops at its cap; its total does not, and a file both staged and edited is one.
  const total = pending?.total ?? counted
  const commitFirst = total > 0 || counted > 0
  const blocked =
    dirty.length > 0
      ? `${folderName(plan?.checkout ?? into)} has uncommitted changes`
      : commitFirst && message.trim() === ''
        ? 'Needs a commit message'
        : undefined

  const merge = async (): Promise<void> => {
    setMerging(true)
    setError(null)
    if (commitFirst) {
      try {
        await runtimeClient.call('worktree.commit', { worktreeId, message, all: true })
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
        setMerging(false)
        return
      }
    }
    const why = await mergeIntoBase(worktreeId)
    if (why === null) return
    setError(why)
    setMerging(false)
  }

  return (
    <Confirm
      title={`Merge ${name} into ${into}?`}
      titleHint={plan?.checkout}
      cancel="Cancel"
      confirm={merging ? 'Merging…' : commitFirst ? 'Commit & Merge' : 'Merge'}
      tone="primary"
      confirmDisabled={merging || blocked !== undefined}
      {...(merging || blocked === undefined ? {} : { confirmHint: blocked })}
      onCancel={closeDialog}
      onConfirm={() => void merge()}
    >
      {branch === null || branch.total === 0 ? null : (
        <div className="merge__stat">
          <span>{branchStat(branch)}</span>
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              closeDialog()
              reviewBranch(worktreeId)
            }}
          >
            Review
          </button>
        </div>
      )}
      {commits.length > 0 ? <Lines lines={commits} /> : null}
      {commitFirst ? (
        <>
          <p className="confirm__body">{`${(total || counted).toLocaleString('en-US')} uncommitted`}</p>
          <Lines lines={uncommitted} total={total} />
          <input
            className="field__input"
            type="text"
            value={message}
            placeholder="Commit message"
            aria-label="Commit message"
            autoFocus
            disabled={merging}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || merging || blocked !== undefined) return
              event.preventDefault()
              void merge()
            }}
          />
        </>
      ) : null}
      {dirty.length > 0 ? (
        <>
          <p className="confirm__body" title={plan?.checkout}>
            Uncommitted in {folderName(plan?.checkout ?? into)}
          </p>
          <Lines lines={dirty} />
        </>
      ) : null}
      {error === null ? null : (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </Confirm>
  )
}

/** `3 files +41 −7`: the branch against its base. */
function branchStat(branch: WorktreeChanges): string {
  let added = 0
  let removed = 0
  for (const change of branch.changes) {
    added += change.added ?? 0
    removed += change.removed ?? 0
  }
  return `${branch.total} ${branch.total === 1 ? 'file' : 'files'} +${added} −${removed}`
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** The first few lines, then `+N more` of `total` (the list's own length when it is whole). */
function Lines({ lines, total = lines.length }: { lines: readonly string[]; total?: number }): React.JSX.Element {
  const more = Math.max(total, lines.length) - Math.min(SHOWN, lines.length)
  return (
    <ul className="confirm__files">
      {[...lines.slice(0, SHOWN), ...(more > 0 ? [`+${more.toLocaleString('en-US')} more`] : [])].map((line) => (
        <li key={line} className="confirm__path">
          {line}
        </li>
      ))}
    </ul>
  )
}
