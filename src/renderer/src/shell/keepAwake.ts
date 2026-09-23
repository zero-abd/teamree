// The window's end of keeping this Mac awake: main holds the assertion, this publishes the chosen mode
// and whether an agent is on something, read with `activityOf`, the sidebar's own reducer.

import { useEffect } from 'react'
import type { Terminal } from '@shared/entities'
import { activityOf } from '../sidebar/agentRows'
import type { KeepAwakeMode } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'

/** True while any agent pane is working or waiting on you; shells do not count (the mode is `Agent`). */
export function anyAgentBusy(terminals: Readonly<Record<string, Terminal>>): boolean {
  return Object.values(terminals).some((terminal) => {
    if (terminal.agent === undefined) return false
    const activity = activityOf(terminal)
    return activity === 'working' || activity === 'waiting'
  })
}

/** What the rail's button says: the mode, in one or two words. */
export function keepAwakeLabel(mode: KeepAwakeMode): string {
  switch (mode) {
    case 'on':
      return 'Awake'
    case 'agent':
      return 'Awake · agent'
    case 'off':
      return 'Sleep ok'
  }
}

export function useKeepAwake(): void {
  useEffect(() => {
    // Absent without the preload (tests, a browser on the dev server).
    const bridge = window.teamree?.keepAwake
    if (!bridge) return

    let published: string | null = null
    const publish = (): void => {
      const state = useWorkspaceStore.getState()
      const next = { mode: state.keepAwake, agentBusy: anyAgentBusy(state.terminals) }
      const description = JSON.stringify(next)
      if (description === published) return
      published = description
      bridge.publish(next)
    }

    publish()
    return useWorkspaceStore.subscribe(publish)
  }, [])
}
