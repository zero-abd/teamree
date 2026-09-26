// Asked before a worktree's branch is merged into the base in the project's own checkout: the commits
// that go in, read fresh, and the files in the way when that checkout has uncommitted work.

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
  const base = useWorkspaceStore((state) => state.landings[worktreeId]?.base ?? 'main')
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const mergeIntoBase = useWorkspaceStore((state) => state.mergeIntoBase)
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

  const into = plan?.into ?? base
  const name = worktree === undefined ? 'this worktree' : `"${worktreeLabel(worktreeDisplay(worktree))}"`
  const dirty = plan?.dirty ?? []
  const commits = (plan?.commits ?? []).map((commit) => `${commit.shortSha} ${commit.subject}`)

  const merge = (): void => {
    setMerging(true)
    setError(null)
    void mergeIntoBase(worktreeId).then((why) => {
      if (why === null) return
      setError(why)
      setMerging(false)
    })
  }

  return (
    <Confirm
      title={`Merge ${name} into ${into}?`}
      titleHint={plan?.checkout}
      cancel="Cancel"
      confirm={merging ? 'Merging…' : 'Merge'}
      tone="primary"
      confirmDisabled={merging || dirty.length > 0}
      onCancel={closeDialog}
      onConfirm={merge}
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

function Lines({ lines }: { lines: readonly string[] }): React.JSX.Element {
  const more = lines.length - SHOWN
  return (
    <ul className="confirm__files">
      {[...lines.slice(0, SHOWN), ...(more > 0 ? [`+${more} more`] : [])].map((line) => (
        <li key={line} className="confirm__path">
          {line}
        </li>
      ))}
    </ul>
  )
}
