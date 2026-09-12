// Naming a task and picking what it starts from. Submitting closes the dialog
// at once: creation is a background job, and its progress belongs on the
// sidebar row, not behind a spinner in a box.

import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'

const CUSTOM = '__custom__'

export function CreateWorktreeDialog({ projectId }: { projectId: string }): React.JSX.Element | null {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const createWorktree = useWorkspaceStore((state) => state.createWorktree)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [name, setName] = useState('')
  const [choice, setChoice] = useState<string>(project?.baseRef ?? 'HEAD')
  const [customRef, setCustomRef] = useState('')

  const startPoints = useMemo(() => {
    const refs = new Set<string>()
    if (project) refs.add(project.baseRef)
    refs.add('HEAD')
    for (const worktree of worktrees) {
      if (worktree.projectId === projectId && worktree.state === 'ready') refs.add(worktree.branch)
    }
    return [...refs]
  }, [project, projectId, worktrees])

  if (!project) return null

  const startedFrom = choice === CUSTOM ? customRef.trim() : choice
  const canSubmit = name.trim().length > 0 && startedFrom.length > 0

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    createWorktree({ projectId, name: name.trim(), startedFrom })
  }

  return (
    <Modal title="New worktree" description={project.name} onClose={closeDialog}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Task</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="rewrite the pager"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field__hint">
            branch <code>{branchNameFromTask(name)}</code>
          </span>
        </label>

        <label className="field">
          <span className="field__label">Start from</span>
          <select className="field__input" value={choice} onChange={(event) => setChoice(event.target.value)}>
            {startPoints.map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
            <option value={CUSTOM}>Another ref or commit…</option>
          </select>
        </label>

        {choice === CUSTOM ? (
          <label className="field">
            <span className="field__label">Ref or commit</span>
            <input
              className="field__input field__input--mono"
              value={customRef}
              onChange={(event) => setCustomRef(event.target.value)}
              placeholder="origin/release-4.2"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}

        <footer className="form__actions">
          <p className="form__note">Creation continues in the background.</p>
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            Create worktree
          </button>
        </footer>
      </form>
    </Modal>
  )
}
