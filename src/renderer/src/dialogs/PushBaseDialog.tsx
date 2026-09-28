// Pushing the project checkout's base to origin: what a local landing still owes it, and a refused push as one line,
// git's words behind Details, Pull and Retry when origin moved, and Undo Merge when origin's cannot be pulled in.

import { useState } from 'react'
import { useWorkspaceStore, type PushBaseFailure } from '../state/workspaceStore'
import { Confirm } from './Confirm'

const BUSY = { pushing: 'Pushing…', pulling: 'Pulling…', undoing: 'Undoing…' } as const

export function PushBaseDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const base = useWorkspaceStore((state) => state.bases[projectId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const pushBase = useWorkspaceStore((state) => state.pushBase)
  const undoBaseMerge = useWorkspaceStore((state) => state.undoBaseMerge)
  const [failure, setFailure] = useState<PushBaseFailure | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState<keyof typeof BUSY | null>(null)

  const branch = base?.branch ?? 'main'
  const pull = failure?.kind === 'rejected'
  // A pull that conflicted would conflict again: the way on is to undo, never to retry.
  const undo = failure?.conflicts !== undefined
  const counts = [
    base?.ahead ? `${base.ahead} ahead of ${base.upstream ?? 'origin'}` : '',
    base?.behind ? `${base.behind} behind` : ''
  ].filter(Boolean)

  const push = async (): Promise<void> => {
    setBusy(pull ? 'pulling' : 'pushing')
    const why = await pushBase(projectId, pull)
    setBusy(null)
    setFailure(why)
  }

  const reset = async (): Promise<void> => {
    setBusy('undoing')
    setRefused(await undoBaseMerge(projectId))
    setBusy(null)
  }

  return (
    <Confirm
      title={`Push ${branch} to origin?`}
      titleHint={project?.path}
      cancel={failure === null ? 'Cancel' : 'Close'}
      confirm={busy === null ? (undo ? 'Undo Merge' : retryLabel(failure)) : BUSY[busy]}
      tone="primary"
      confirmDisabled={busy !== null || refused !== null}
      onCancel={closeDialog}
      onConfirm={() => void (undo ? reset() : push())}
    >
      {counts.length === 0 ? null : <p className="confirm__body">{counts.join(' · ')}</p>}
      {failure === null ? null : (
        <>
          <p className="push__error" role="alert">
            {`Push failed: ${failure.message}`}
          </p>
          {failure.detail === failure.message ? null : (
            <details className="push__details">
              <summary>Details</summary>
              <pre className="push__git">{failure.detail}</pre>
            </details>
          )}
        </>
      )}
      {refused === null ? null : (
        <p className="push__error" role="alert">
          {`Undo failed: ${refused}`}
        </p>
      )}
    </Confirm>
  )
}

function retryLabel(failure: PushBaseFailure | null): string {
  if (failure === null) return 'Push'
  return failure.kind === 'rejected' ? 'Pull and Retry' : 'Retry'
}
