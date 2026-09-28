// Sticky cards for a damaged workspace.json and for saves that fail: Reveal the kept file, Retry the save.

import type { WorkspaceFileProblem } from '@shared/entities'
import { Icon } from '../icons/Icon'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button, IconButton } from '../ui/Button'
import { problemKey, useStoreProblems } from './useStoreProblems'

export function StoreProblemCards(): React.JSX.Element | null {
  const { problems, retrying, retry, dismiss } = useStoreProblems()
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  if (problems.length === 0) return null
  return (
    <div className="notices" role="alert">
      {problems.map((problem) => {
        const { title, detail } = problemText(problem)
        const saving = problem.kind === 'saveFailed'
        return (
          <div key={problemKey(problem)} className="notice notice--error">
            <span className="notice__icon" aria-hidden="true">
              <Icon name="alert" />
            </span>
            <div className="notice__body">
              <p className="notice__title">{title}</p>
              <p className="notice__detail">{detail}</p>
              <div className="notice__actions">
                {saving ? (
                  <Button variant="secondary" size="sm" disabled={retrying} onClick={retry}>
                    Retry
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void revealInFinder(problem.keptAt ?? problem.filePath, 'the file')}
                  >
                    Reveal
                  </Button>
                )}
              </div>
            </div>
            {saving ? null : (
              <IconButton
                icon="close"
                label="Dismiss message"
                className="notice__close"
                onClick={() => dismiss(problem)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export function problemText(problem: WorkspaceFileProblem): { title: string; detail: string } {
  switch (problem.kind) {
    case 'restored':
      return { title: 'Workspace restored from backup', detail: `Damaged file kept as ${fileName(problem.keptAt)}` }
    case 'unreadable':
      return {
        title: `${fileName(problem.filePath)} could not be read`,
        detail: problem.keptAt === undefined ? 'Not saving over it' : `Kept as ${fileName(problem.keptAt)}`
      }
    case 'saveFailed':
      return { title: 'Could not save', detail: problem.diskFull ? 'Disk full' : problem.reason }
  }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
