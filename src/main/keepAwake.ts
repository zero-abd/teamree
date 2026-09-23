// Keeping this Mac awake, when the window says so. `prevent-app-suspension`
// only: on macOS that is `PreventUserIdleSystemSleep`, the display may still
// go dark, and Electron documents `prevent-display-sleep` outranking it.
// Whether an agent is busy is decided in the window (`activityOf`), not here.

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

function isMode(value: unknown): value is KeepAwakeMode {
  return typeof value === 'string' && (KEEP_AWAKE_MODES as readonly string[]).includes(value)
}

/** The state, rebuilt field by field, or null. Rebuilt for the reason `readNoticeSettings` is. */
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
 * Listens for the window's state. Returns the way to stop, which also lets go
 * of the machine. The assertion goes with the window that asked for it.
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
