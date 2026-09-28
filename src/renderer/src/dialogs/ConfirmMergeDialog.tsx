// Asked before a worktree's branch is merged into the base in the project's own checkout, or a child's
// into its parent's: the commits that go in, read fresh, and the files in the way when that checkout has uncommitted work.
// Work uncommitted in the worktree itself is committed first, under a message typed here, never left behind.

import { useEffect, useRef, useState } from 'react'
import type { WorktreeChanges, WorktreeMerge } from '@shared/entities'
import { useReviewStore } from '../review/reviewStore'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useChildRows } from '../workspace/rightPanel/ChildrenSection'
import { mergeable, unmerged } from '../workspace/rightPanel/childrenModel'
import { useChildren } from '../workspace/rightPanel/childrenStore'
import { CommitFrom } from '../workspace/rightPanel/CommitFrom'
import { useCommitMessage } from '../workspace/rightPanel/commitMessage'
import { harnessName } from '../agents/harnesses'
import { askerOf, conflictHeadline, updateSides } from '../workspace/rightPanel/conflictState'
import { Confirm } from './Confirm'

const SHOWN = 5

export function ConfirmMergeDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const landing = useWorkspaceStore((state) => state.landings[worktreeId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const noteCommit = useWorkspaceStore((state) => state.noteCommit)
  const mergeIntoBase = useWorkspaceStore((state) => state.mergeIntoBase)
  const pending = useWorkspaceStore((state) => state.changes[worktreeId])
  const status = useWorkspaceStore((state) => state.statuses[worktreeId])
  const { message, from, setMessage } = useCommitMessage(worktreeId)
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const reviewBranch = useReviewStore((state) => state.reviewBranch)
  const [plan, setPlan] = useState<WorktreeMerge | null>(null)
  const [branch, setBranch] = useState<WorktreeChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  // A child lands in its parent's branch, which is not main's to push.
  const offerPush =
    worktree !== undefined && worktree.parentId === undefined && landing !== undefined && landing.remote !== false
  const pushChoice = useWorkspaceStore((state) =>
    worktree === undefined
      ? false
      : (state.pushOnMerge[worktree.projectId] ?? state.bases[worktree.projectId]?.upstream !== undefined)
  )
  const [pushEdit, setPushEdit] = useState<boolean | null>(null)
  const push = offerPush && (pushEdit ?? pushChoice)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const asker = useWorkspaceStore((state) => askerOf(state, worktreeId))
  const showRightPanelTab = useWorkspaceStore((state) => state.showRightPanelTab)
  const updateWorktree = useWorkspaceStore((state) => state.updateWorktree)
  const askToResolve = useWorkspaceStore((state) => state.askToResolve)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const children = useChildRows(worktreeId).filter(unmerged)
  const landable = children.filter(mergeable)

  // Selected, so typing replaces a suggestion rather than adding to it.
  useEffect(() => {
    if (from !== null) messageBox.current?.select()
  }, [])

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

  // The parent's stored name may be a task's clipped first line; its title is whole.
  const parent = worktrees.find((entry) => entry.id === landing?.parent?.worktreeId)
  const into =
    (parent === undefined ? undefined : worktreeLabel(worktreeDisplay(parent))) ??
    landing?.parent?.name ??
    plan?.into ??
    landing?.base ??
    'main'
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

  /** Commits what is uncommitted first; false, having said why, when that failed. */
  const committed = async (): Promise<boolean> => {
    if (!commitFirst) return true
    noteCommit(worktreeId)
    try {
      await runtimeClient.call('worktree.commit', { worktreeId, message, all: true })
      setMessage('')
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setMerging(false)
      // A hook's refusal is said on its notice and in the Changes panel, with the way out.
      if (noteCommit(worktreeId, failure)) closeDialog()
      return false
    }
  }

  const merge = async (): Promise<void> => {
    setMerging(true)
    setError(null)
    if (!(await committed())) return
    const why = await mergeIntoBase(worktreeId, offerPush ? push : undefined)
    if (why === null) return
    // A conflict the commit just made is said as one, with the way through, rather than as git's line.
    const replanned = await runtimeClient.call('worktree.mergeIntoBase', { worktreeId, dryRun: true }).catch(() => null)
    if (replanned?.conflicts !== undefined) setPlan(replanned)
    else setError(why)
    setMerging(false)
  }

  /** Lands the children first, then asks about this one again; a stop is shown where it can be resolved. */
  const mergeChildrenFirst = async (): Promise<void> => {
    closeDialog()
    const store = useChildren.getState()
    const landed = await store.mergeChildren(
      worktreeId,
      landable.map((child) => child.worktreeId)
    )
    if (landed) openDialog({ kind: 'confirm-merge', worktreeId })
    else await store.showChildren(worktreeId)
  }

  /** Brings what it would conflict with into the task, where the conflict can be resolved, and shows it there. */
  const takeIn = async (ask: boolean): Promise<void> => {
    setMerging(true)
    setError(null)
    if (!(await committed())) return
    await showConflicts()
    const update = await updateWorktree(worktreeId, true)
    if (ask && update?.outcome === 'conflicts') await askToResolve(worktreeId, update.conflicts)
  }

  const showConflicts = async (): Promise<void> => {
    closeDialog()
    const store = useWorkspaceStore.getState()
    if (store.activeWorktreeId !== worktreeId) await store.openWorktree(worktreeId)
    showRightPanelTab('changes')
  }

  const sides = updateSides(worktrees, projects, worktreeId)
  const title = `Merge ${name} into ${into}?`
  const hint = plan?.checkout === undefined ? title : `${title}\n${plan.checkout}`
  if (status?.operation !== undefined) {
    return (
      <Confirm
        title={title}
        titleHint={title}
        body={conflictHeadline(status.operation, sides, status.conflicted)}
        cancel="Cancel"
        confirm="Show Conflicts"
        tone="primary"
        onCancel={closeDialog}
        onConfirm={() => void showConflicts()}
      />
    )
  }
  const conflicts = plan?.conflicts ?? []
  if (conflicts.length > 0) {
    const needsMessage = commitFirst && message.trim() === ''
    return (
      <Confirm
        title={title}
        titleHint={hint}
        cancel="Cancel"
        confirm={worktree?.parentId === undefined ? `Update from ${into}` : 'Update from Parent'}
        tone="primary"
        confirmDisabled={merging || needsMessage}
        {...(needsMessage ? { confirmHint: 'Needs a commit message' } : {})}
        {...(asker === null
          ? {}
          : { decline: { label: `Ask ${harnessName(asker)} to Resolve`, onChoose: () => void takeIn(true) } })}
        onCancel={closeDialog}
        onConfirm={() => void takeIn(false)}
      >
        <p className="confirm__body">{`Conflicts with ${sides.incoming}`}</p>
        <Lines lines={conflicts} />
        {commitFirst ? (
          <>
            <textarea
              ref={messageBox}
              className="textarea field__message"
              rows={1}
              value={message}
              placeholder="Commit message"
              aria-label="Commit message"
              autoFocus
              disabled={merging}
              onChange={(event) => setMessage(event.target.value)}
            />
            <CommitFrom from={merging ? null : from} onClear={() => setMessage('')} />
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

  return (
    <Confirm
      title={title}
      titleHint={hint}
      cancel="Cancel"
      confirm={merging ? 'Merging…' : commitFirst ? 'Commit & Merge' : 'Merge'}
      tone="primary"
      confirmDisabled={merging || blocked !== undefined}
      {...(merging || blocked === undefined ? {} : { confirmHint: blocked })}
      onCancel={closeDialog}
      onConfirm={() => void merge()}
    >
      {children.length === 0 ? null : (
        <div className="merge__stat merge__children">
          <span>{`${children.length} ${children.length === 1 ? 'child' : 'children'} not merged`}</span>
          <button
            type="button"
            className="button button--small"
            disabled={merging || landable.length === 0}
            title={children.map((child) => `${child.title} · ${child.stage}`).join('\n')}
            onClick={() => void mergeChildrenFirst()}
          >
            Merge Them First
          </button>
        </div>
      )}
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
          <textarea
            ref={messageBox}
            className="textarea field__message"
            rows={1}
            value={message}
            placeholder="Commit message"
            aria-label="Commit message"
            autoFocus
            disabled={merging}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || merging || blocked !== undefined) return
              event.preventDefault()
              void merge()
            }}
          />
          <CommitFrom from={merging ? null : from} onClear={() => setMessage('')} />
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
      {offerPush ? (
        <label className="confirm__check">
          <input
            type="checkbox"
            checked={push}
            disabled={merging}
            onChange={(event) => setPushEdit(event.target.checked)}
          />
          {`Push ${into} to origin`}
        </label>
      ) : null}
      {error === null ? null : (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </Confirm>
  )
}

/** `3 files +41 −7`: the branch against its base. Lines are counted per listed file, so a cut-off list gives none. */
function branchStat(branch: WorktreeChanges): string {
  const files = `${branch.total.toLocaleString('en-US')} ${branch.total === 1 ? 'file' : 'files'}`
  if (branch.truncated) return files
  let added = 0
  let removed = 0
  for (const change of branch.changes) {
    added += change.added ?? 0
    removed += change.removed ?? 0
  }
  return `${files} +${added} −${removed}`
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
