// Asked before a worktree's branch is merged into the base in the project's own checkout, or a child's
// into its parent's: the commits that go in, read fresh, and the files in the way when that checkout has uncommitted work.

import { useEffect, useState } from 'react'
import type { WorktreeMerge } from '@shared/entities'
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
  const [plan, setPlan] = useState<WorktreeMerge | null>(null)
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
    return () => {
      alive = false
    }
  }, [worktreeId])

  const into = landing?.parent?.name ?? plan?.into ?? landing?.base ?? 'main'
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
