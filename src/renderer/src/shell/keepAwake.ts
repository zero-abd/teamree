// The window's end of keeping this Mac awake.
//
// The assertion belongs to the main process, which is the only one that can
// hold one — and, as with notifications, the one that knows least: which mode
// somebody chose is in this window's storage, and whether an agent is on
// something is a reading of the panes this window is already drawing. So both
// are published whenever either changes, and nothing in main has to guess.
//
// "On something" is `activityOf`, the sidebar's own reducer, and nothing else:
// the rule that ranks a hook's word over a bell over a title is written once,
// there, and a second copy here would be free to disagree with the row the
// person is looking at.

import { useEffect } from 'react'
import type { Terminal } from '@shared/entities'
import { activityOf } from '../sidebar/agentRows'
import type { KeepAwakeMode } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'

/**
 * True while any agent pane is working or waiting on you.
 *
 * Agent panes only. A shell with a build running in it is busy too, but the
 * mode is called `Agent` and a mode that held the machine awake for a `tail
 * -f` nobody is watching would be called something else.
 */
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
    // Absent in a test that renders the app without the preload, and in a
    // browser pointed at the dev server. Neither can hold a machine awake.
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
