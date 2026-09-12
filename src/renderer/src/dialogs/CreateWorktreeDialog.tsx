// Naming a task and picking what it starts from. Submitting closes the dialog
// at once: creation is a background job, and its progress belongs on the
// sidebar row, not behind a spinner in a box.

import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
import { useStartPoints } from './useStartPoints'

export function CreateWorktreeDialog({ projectId }: { projectId: string }): React.JSX.Element | null {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const createWorktree = useWorkspaceStore((state) => state.createWorktree)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [name, setName] = useState('')
  const [startPoint, setStartPoint] = useState<StartPointValue>({ text: project?.baseRef ?? '', option: null })
  const [touched, setTouched] = useState(false)
  const { state, reload } = useStartPoints(projectId)

  // The listing lands after the dialog opens, so the base ref it names — and
  // the sha behind it — replace the placeholder, unless the user has already
  // put something of their own in the box.
  useEffect(() => {
    if (touched || state.phase !== 'ready') return
    const base = state.list.options.find((option) => option.isBase) ?? null
    setStartPoint({ text: base?.ref ?? state.list.baseRef, option: base })
  }, [state, touched])

  if (!project) return null

  const branchName = branchNameFromTask(name)
  const startedFrom = startPoint.text.trim()
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
            branch <code>{branchName}</code>
          </span>
        </label>

        <StartPointPicker
          state={state}
          onReload={reload}
          value={startPoint}
          onChange={(value) => {
            setTouched(true)
            setStartPoint(value)
          }}
          branchName={branchName}
        />

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
