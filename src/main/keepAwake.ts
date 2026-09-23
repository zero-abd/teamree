// Keeping this Mac awake, when the window says so.
//
// Three modes. `on` holds the machine awake for as long as the app runs.
// `agent` holds it only while an agent pane is on something — working, or
// waiting on you — which is the default, because the app's premise is that
// you start three agents and walk away, and a laptop that sleeps ten minutes
// into that is three agents stopped mid-turn. `off` is the OS's own rules.
//
// The blocker is `prevent-app-suspension` in both awake modes. On macOS that
// is a `PreventUserIdleSystemSleep` assertion: the machine stays up and the
// display is still allowed to go dark, which is what somebody who has walked
// away from a running agent wants. `prevent-display-sleep` would keep the
// screen lit on a laptop nobody is looking at, and Electron documents that it
// outranks the other, so a single kind is used and a single assertion held.
//
// Whether an agent is busy is decided in the window, not here. The main
// process holds the raw facts — `busy`, `lastBellAt`, `agentEvent` — but the
// rule that turns them into "working or waiting on you" is `activityOf` in the
// sidebar's reducer, and it ranks a hook's word over a bell over a title.
// Restating that rule here would be a second copy free to disagree with the
// one the sidebar draws. So the window publishes one boolean beside the mode,
// the way it publishes the menu bar's items, and this file holds nothing but
// the edge: started once when the answer becomes yes, stopped once when it
// becomes no.

import type { IpcMain, IpcMainEvent, PowerSaveBlocker } from 'electron'

/** Keep in step with `src/preload/index.ts`, which repeats the literal. */
export const KEEP_AWAKE_PUBLISH_CHANNEL = 'teamree:keep-awake:publish'

export type KeepAwakeMode = 'on' | 'agent' | 'off'

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['on', 'agent', 'off']

export type KeepAwakeState = {
  mode: KeepAwakeMode
  /** True while any agent pane is working or waiting on you, as the window reads it. */
  agentBusy: boolean
}

/** Until the window says otherwise, which it does on its first render. */
export const DEFAULT_KEEP_AWAKE_STATE: KeepAwakeState = { mode: 'agent', agentBusy: false }

function isMode(value: unknown): value is KeepAwakeMode {
  return typeof value === 'string' && (KEEP_AWAKE_MODES as readonly string[]).includes(value)
}

/**
 * The state, rebuilt field by field, or null if the message was not one.
 *
 * Rebuilt rather than passed through for the reason `readNoticeSettings` is:
 * this arrives over IPC, and a mode that is not one of the three would read
 * as "off" in a comparison written the obvious way.
 */
export function readKeepAwakeState(value: unknown): KeepAwakeState | null {
  if (typeof value !== 'object' || value === null) return null
  const state = value as Record<string, unknown>
  if (!isMode(state.mode) || typeof state.agentBusy !== 'boolean') return null
  return { mode: state.mode, agentBusy: state.agentBusy }
}

export function shouldStayAwake(state: KeepAwakeState): boolean {
  switch (state.mode) {
    case 'on':
      return true
    case 'agent':
      return state.agentBusy
    case 'off':
      return false
  }
}

/** Electron's `powerSaveBlocker`, reduced to what this uses. */
export type PowerSaveBlockerLike = Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>

export type KeepAwake = {
  /** Brings the blocker in line with the state: one start or one stop per edge, or nothing. */
  apply: (state: KeepAwakeState) => void
  /** Lets go, whatever the last state said. */
  release: () => void
  blocking: () => boolean
}

export function createKeepAwake(blocker: PowerSaveBlockerLike): KeepAwake {
  let held: number | null = null

  const release = (): void => {
    if (held === null) return
    blocker.stop(held)
    held = null
  }

  return {
    apply(state) {
      const wanted = shouldStayAwake(state)
      if (wanted && held === null) held = blocker.start('prevent-app-suspension')
      else if (!wanted) release()
    },
    release,
    blocking: () => held !== null && blocker.isStarted(held)
  }
}

export type KeepAwakeHost = {
  blocker: PowerSaveBlockerLike
  /** The window's main frame is the only thing allowed to hold this Mac awake. */
  fromMainFrame: (event: IpcMainEvent) => boolean
}

/**
 * Listens for the window's state. Returns the way to stop, which also lets
 * go of the machine.
 *
 * The assertion goes with the window that asked for it, the way the menu bar's
 * items go with the window that published them: an app with no window left
 * holding a laptop awake is the one outcome nobody chose.
 */
export function installKeepAwake(ipc: IpcMain, host: KeepAwakeHost): { stop: () => void; blocking: () => boolean } {
  const awake = createKeepAwake(host.blocker)
  let published: { isDestroyed: () => boolean } | null = null

  const onPublish = (event: IpcMainEvent, payload: unknown): void => {
    if (!host.fromMainFrame(event)) return
    const state = readKeepAwakeState(payload)
    if (!state) return
    awake.apply(state)

    const sender = event.sender
    if (published !== sender) {
      published = sender
      sender.once('destroyed', () => {
        if (published !== sender) return
        published = null
        awake.release()
      })
    }
  }

  ipc.on(KEEP_AWAKE_PUBLISH_CHANNEL, onPublish)
  return {
    stop() {
      ipc.removeAllListeners(KEEP_AWAKE_PUBLISH_CHANNEL)
      awake.release()
    },
    blocking: awake.blocking
  }
}
