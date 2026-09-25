// Move to Trash… for a project: what would be lost, read fresh on open. Its worktrees are removed
// with a copy kept first, then the folder goes to the macOS Trash.

import { useEffect, useState } from 'react'
import type { ResultOf } from '@shared/methods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function ConfirmTrashProjectDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const confirmTrashProject = useWorkspaceStore((state) => state.confirmTrashProject)
  const [preview, setPreview] = useState<ResultOf<'project.trashPreview'> | null>(null)
  useEffect(() => {
    let alive = true
    runtimeClient
      .call('project.trashPreview', { projectId })
      .then((read) => {
        if (alive) setPreview(read)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  const lines =
    preview === null
      ? []
      : [
          count(preview.uncommitted, 'uncommitted file', 'uncommitted files'),
          count(preview.unpushed, 'unpushed commit', 'unpushed commits'),
          count(preview.worktrees, 'teamree worktree', 'teamree worktrees')
        ]

  return (
    <Confirm
      title={`Move ${project === undefined ? 'this project' : `"${project.name}"`} to Trash?`}
      titleHint={project?.path}
      cancel="Cancel"
      confirm="Move to Trash"
      deleteConfirms
      onCancel={closeDialog}
      onConfirm={() => void confirmTrashProject(projectId)}
    >
      {lines.length > 0 ? (
        <ul className="confirm__files">
          {lines.map((line) => (
            <li key={line} className="confirm__path">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </Confirm>
  )
}
