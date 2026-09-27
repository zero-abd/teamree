// The Jac Graph Memory add-on as Settings shows it: read on open and again whenever the runtime says it moved.

import { useEffect, useState } from 'react'
import type { AddonStatus } from '@shared/contextProvider'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

export type AddonStatusState = {
  status: AddonStatus | null
  /** Why the last install call did not reach the runtime, or null. */
  problem: string | null
  install: () => void
}

export function useAddonStatus(): AddonStatusState {
  const [status, setStatus] = useState<AddonStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      runtimeClient.call('addons.status', {}).then(
        (rows) => {
          if (live) setStatus(rows.find((row) => row.id === 'jac-memory') ?? null)
        },
        () => {}
      )
    }
    read()
    const watch = runtimeClient.watchWorkspace((event) => {
      if (event.type === 'addons' || event.type === 'settings') read()
    })
    return () => {
      live = false
      void watch.close()
    }
  }, [])
  const install = (): void => {
    setProblem(null)
    setStatus((current) => (current === null ? current : { ...current, state: 'installing' }))
    runtimeClient.call('addons.install', { id: 'jac-memory' }).then(setStatus, (error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
  }
  return { status, problem, install }
}
