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

/** Whether the mode is holding the machine awake right now; the rail's icon is filled while it is. */
export function holdsAwake(mode: KeepAwakeMode, agentBusy: boolean): boolean {
  return mode === 'on' || (mode === 'agent' && agentBusy)
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
