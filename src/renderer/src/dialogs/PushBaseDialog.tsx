// Pushing the project checkout's base to origin: what a local landing still owes it, and a refused push as one line,
// git's words behind Details, and Pull and Retry when origin moved.

import { useState } from 'react'
import { useWorkspaceStore, type PushBaseFailure } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function PushBaseDialog({
  projectId,
  failure: first
}: {
  projectId: string
  failure?: PushBaseFailure
}): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const base = useWorkspaceStore((state) => state.bases[projectId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const pushBase = useWorkspaceStore((state) => state.pushBase)
  const [failure, setFailure] = useState<PushBaseFailure | null>(first ?? null)
  const [busy, setBusy] = useState<'pushing' | 'pulling' | null>(null)

  const branch = base?.branch ?? 'main'
  const pull = failure?.kind === 'rejected'
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

  return (
    <Confirm
      title={`Push ${branch} to origin?`}
      titleHint={project?.path}
      cancel={failure === null ? 'Cancel' : 'Close'}
      confirm={busy === 'pulling' ? 'Pulling…' : busy === 'pushing' ? 'Pushing…' : retryLabel(failure)}
      tone="primary"
      confirmDisabled={busy !== null}
      onCancel={closeDialog}
      onConfirm={() => void push()}
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
    </Confirm>
  )
}

function retryLabel(failure: PushBaseFailure | null): string {
  if (failure === null) return 'Push'
  return failure.kind === 'rejected' ? 'Pull and Retry' : 'Retry'
}
