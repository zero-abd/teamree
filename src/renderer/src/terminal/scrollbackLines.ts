// Scrollback lines is kept in this window's storage, and main sizes what a restart keeps by it: told on
// launch and on every change.

import { useEffect } from 'react'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

export function useScrollbackLines(): void {
  useEffect(() => {
    let told: number | null = null
    const tell = (): void => {
      const lines = useWorkspaceStore.getState().terminalOptions.scrollback
      if (lines === told) return
      told = lines
      runtimeClient.call('settings.set', { scrollbackLines: lines }).catch(() => {
        // Told again on the next change; until then a restart keeps the last value main heard.
        if (told === lines) told = null
      })
    }
    tell()
    return useWorkspaceStore.subscribe(tell)
  }, [])
}
