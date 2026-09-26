// The per-machine switches the runtime acts on, read when the page opens and written through.

import { useEffect, useState } from 'react'
import type { RuntimeSettings } from '@shared/settings'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

export type RuntimeSettingsState = {
  /** Null until the runtime has answered. */
  settings: RuntimeSettings | null
  /** Why the last change did not stick, or null. */
  problem: string | null
  change: (changes: Partial<RuntimeSettings>) => void
}

export function useRuntimeSettings(): RuntimeSettingsState {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    runtimeClient.call('settings.get', {}).then(
      (read) => {
        if (live) setSettings(read)
      },
      (error: unknown) => {
        if (live) setProblem(reasonFor(error))
      }
    )
    return () => {
      live = false
    }
  }, [])

  const change = (changes: Partial<RuntimeSettings>): void => {
    const before = settings
    if (before !== null) setSettings({ ...before, ...changes })
    setProblem(null)
    runtimeClient.call('settings.set', changes).then(setSettings, (error: unknown) => {
      setSettings(before)
      setProblem(reasonFor(error))
    })
  }
  return { settings, problem, change }
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
