// Land All, asked first: the tasks in the order they land, each with the commit message its uncommitted work
// goes in under, a predicted clash unticked, and Push per project as a single Land offers it.

import { useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ChildRow, HeldBack } from '../workspace/rightPanel/childrenModel'
import { useChildren } from '../workspace/rightPanel/childrenStore'
import { commitSuggestion, shownDraft, useCommitDrafts } from '../workspace/rightPanel/commitMessage'
import { Confirm } from './Confirm'

type Props = {
  /** In landing order; the held ones start unticked. */
  rows: readonly ChildRow[]
  held: readonly HeldBack[]
  onClose: () => void
}

export function ConfirmLandAllDialog({ rows, held, onClose }: Props): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const landings = useWorkspaceStore((state) => state.landings)
  const bases = useWorkspaceStore((state) => state.bases)
  const pushOnMerge = useWorkspaceStore((state) => state.pushOnMerge)
  const drafts = useCommitDrafts((state) => state.drafts)
  const landAll = useChildren((state) => state.landAll)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set(held.map((each) => each.worktreeId)))
  const [pushEdits, setPushEdits] = useState<Readonly<Record<string, boolean>>>({})

  const worktreeOf = (worktreeId: string) => worktrees.find((entry) => entry.id === worktreeId)
  const chosen = rows.filter((row) => !unticked.has(row.worktreeId))
  // A child lands in its parent's branch, which is not main's to push.
  const pushable = new Map<string, string>()
  for (const row of chosen) {
    const worktree = worktreeOf(row.worktreeId)
    const landing = landings[row.worktreeId]
    if (worktree === undefined || worktree.parentId !== undefined || landing?.remote === false) continue
    pushable.set(worktree.projectId, landing?.base ?? 'main')
  }
  const pushes = (projectId: string): boolean =>
    pushEdits[projectId] ?? pushOnMerge[projectId] ?? bases[projectId]?.upstream !== undefined

  const hint = (row: ChildRow): string => {
    const clash = held.find((each) => each.worktreeId === row.worktreeId)
    if (clash !== undefined) return `Conflicts with ${clash.clashesWith}`
    if (row.uncommitted === 0) return ''
    const message = shownDraft(drafts[row.worktreeId], commitSuggestion(worktreeOf(row.worktreeId))).text.trim()
    return message === '' ? 'Needs a commit message' : `✎ ${message.split('\n')[0]}`
  }
  const toggle = (worktreeId: string): void => {
    const next = new Set(unticked)
    if (!next.delete(worktreeId)) next.add(worktreeId)
    setUnticked(next)
  }
  const land = (): void => {
    onClose()
    void landAll(
      chosen.map((row) => row.worktreeId),
      [...pushable.keys()].filter(pushes),
      held.filter((each) => unticked.has(each.worktreeId))
    )
  }

  return (
    <Confirm
      title="Land in this order?"
      cancel="Cancel"
      confirm={`Land ${chosen.length}`}
      tone="primary"
      confirmDisabled={chosen.length === 0}
      onCancel={onClose}
      onConfirm={land}
    >
      <ol className="cleanup landall">
        {rows.map((row, index) => {
          const note = hint(row)
          return (
            <li key={row.worktreeId}>
              <label className="cleanup__label" title={row.title}>
                <input
                  type="checkbox"
                  aria-label={row.title}
                  checked={!unticked.has(row.worktreeId)}
                  onChange={() => toggle(row.worktreeId)}
                />
                <span className="landall__order">{index + 1}</span>
                <span className="cleanup__name landall__name">{row.title}</span>
                {note === '' ? null : (
                  <span className="cleanup__hint landall__hint" title={note}>
                    {note}
                  </span>
                )}
              </label>
            </li>
          )
        })}
      </ol>
      {[...pushable].map(([projectId, base]) => {
        const project = projects.find((entry) => entry.id === projectId)
        const where = pushable.size > 1 && project !== undefined ? ` · ${project.name}` : ''
        return (
          <label key={projectId} className="confirm__check">
            <input
              type="checkbox"
              checked={pushes(projectId)}
              onChange={(event) => setPushEdits({ ...pushEdits, [projectId]: event.target.checked })}
            />
            {`Push ${base} to origin${where}`}
          </label>
        )
      })}
    </Confirm>
  )
}
