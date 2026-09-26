// Clean Up Merged: a project's landed worktrees as a checklist, read with a dry run on open. A child
// never stays behind while its parent goes, so unchecking one unchecks its parents too.

import { useEffect, useMemo, useState } from 'react'
import type { Worktree, WorktreeCleanup } from '@shared/entities'
import { descendantsOf } from '@shared/taskTree'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

type Row = { worktree: Worktree; depth: number; hint: string; stays: boolean }

export function ConfirmCleanUpDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const editedFiles = useWorkspaceStore((state) => state.editedFiles)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const confirmCleanUp = useWorkspaceStore((state) => state.confirmCleanUp)
  const [plan, setPlan] = useState<WorktreeCleanup | null>(null)
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.cleanMerged', { projectId, dryRun: true })
      .then((read) => {
        if (alive) setPlan(read)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  const rows = useMemo(
    () => (plan === null ? [] : checklist(plan, worktrees, editedFiles)),
    [plan, worktrees, editedFiles]
  )
  const listed = rows.map((row) => row.worktree)
  const chosen = rows.filter((row) => !row.stays && !unchecked.has(row.worktree.id)).map((row) => row.worktree.id)

  const toggle = (worktree: Worktree): void => {
    const next = new Set(unchecked)
    if (next.has(worktree.id)) {
      for (const id of [worktree.id, ...descendantsOf(listed, worktree.id).map((below) => below.id)]) next.delete(id)
    } else {
      for (const id of [worktree.id, ...ancestorsOf(listed, worktree)]) next.add(id)
    }
    setUnchecked(next)
  }

  return (
    <Confirm
      title={`Remove merged worktrees${project === undefined ? '' : ` from ${project.name}`}?`}
      titleHint={project?.path}
      {...(plan !== null && rows.length === 0 ? { body: 'Nothing to clean up' } : {})}
      cancel="Cancel"
      confirm={chosen.length === 0 ? 'Remove' : `Remove ${chosen.length}`}
      confirmDisabled={chosen.length === 0}
      deleteConfirms
      onCancel={closeDialog}
      onConfirm={() => void confirmCleanUp(projectId, chosen)}
    >
      {rows.length > 0 ? (
        <ul className="cleanup">
          {rows.map((row) => {
            const title = worktreeDisplay(row.worktree).title
            return (
              <li key={row.worktree.id} className="cleanup__row" style={{ paddingLeft: row.depth * 16 }}>
                <label className="cleanup__label" title={row.worktree.path}>
                  <input
                    type="checkbox"
                    aria-label={title}
                    checked={!row.stays && !unchecked.has(row.worktree.id)}
                    disabled={row.stays}
                    onChange={() => toggle(row.worktree)}
                  />
                  <span className="cleanup__name">{title}</span>
                  {row.hint === '' ? null : <span className="cleanup__hint">{row.hint}</span>}
                </label>
              </li>
            )
          })}
        </ul>
      ) : null}
    </Confirm>
  )
}

/** In the sidebar's order, each child under its parent; a row stays for its own reason or a child's. */
function checklist(
  plan: WorktreeCleanup,
  worktrees: readonly Worktree[],
  editedFiles: Readonly<Record<string, { worktreeId: string }>>
): Row[] {
  const reasons = new Map<string, string>(plan.kept.map((entry) => [entry.worktree.id, entry.reason]))
  const edited = new Set(Object.values(editedFiles).map((file) => file.worktreeId))
  for (const { worktree } of plan.removed) if (edited.has(worktree.id)) reasons.set(worktree.id, 'Unsaved files')
  const ignored = new Map(plan.removed.map((entry) => [entry.worktree.id, entry.ignored ?? 0]))
  const order = new Map(worktrees.map((worktree, index) => [worktree.id, index]))
  const listed = [...plan.removed, ...plan.kept]
    .map((entry) => entry.worktree)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const tree: Worktree[] = []
  const visit = (worktree: Worktree): void => {
    tree.push(worktree)
    for (const below of listed) if (below.parentId === worktree.id) visit(below)
  }
  for (const worktree of listed) if (!listed.some((up) => up.id === worktree.parentId)) visit(worktree)
  return tree.map((worktree) => {
    const childStays = descendantsOf(listed, worktree.id).some((below) => reasons.has(below.id))
    const reason = reasons.get(worktree.id) ?? (childStays ? 'Child stays' : undefined)
    const count = ignored.get(worktree.id) ?? 0
    return {
      worktree,
      depth: ancestorsOf(listed, worktree).length,
      hint: reason ?? (count > 0 ? `${count} ignored` : ''),
      stays: reason !== undefined
    }
  })
}

function ancestorsOf(listed: readonly Worktree[], worktree: Worktree): string[] {
  const up: string[] = []
  for (let at = listed.find((entry) => entry.id === worktree.parentId); at !== undefined && !up.includes(at.id); ) {
    up.push(at.id)
    const parentId = at.parentId
    at = listed.find((entry) => entry.id === parentId)
  }
  return up
}
