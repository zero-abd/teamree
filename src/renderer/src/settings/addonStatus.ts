// The Jac Graph Memory add-on as Settings shows it: read on open, on window focus, on Check Again, and whenever
// the runtime says it moved.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddonStatus } from '@shared/contextProvider'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

export type AddonStatusState = {
  status: AddonStatus | null
  /** Why the last install call did not reach the runtime, or null. */
  problem: string | null
  install: () => void
  /** Reads again, e.g. after uv was installed outside the app. */
  check: () => void
}

export function useAddonStatus(): AddonStatusState {
  const [status, setStatus] = useState<AddonStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const live = useRef(true)
  const read = useCallback((): void => {
    runtimeClient.call('addons.status', {}).then(
      (rows) => {
        if (live.current) setStatus(rows.find((row) => row.id === 'jac-memory') ?? null)
      },
      () => {}
    )
  }, [])
  useEffect(() => {
    live.current = true
    read()
    const watch = runtimeClient.watchWorkspace((event) => {
      if (event.type === 'addons' || event.type === 'settings') read()
    })
    window.addEventListener('focus', read)
    return () => {
      live.current = false
      window.removeEventListener('focus', read)
      void watch.close()
    }
  }, [read])
  const install = (): void => {
    setProblem(null)
    setStatus((current) => (current === null ? current : { ...current, state: 'installing' }))
    runtimeClient.call('addons.install', { id: 'jac-memory' }).then(setStatus, (error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
  }
  return { status, problem, install, check: read }
}
