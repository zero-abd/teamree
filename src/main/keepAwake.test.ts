// The one machine: three modes, one fact about the panes, and a blocker that
// must be started exactly once per edge and stopped exactly once per edge.
//
// Every row below is a sequence of states the window could publish, and the
// blocker's log afterwards. A blocker started twice would hold two assertions
// and release one; a blocker stopped twice would return false the second time
// and say nothing about it.

import type { IpcMain, IpcMainEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  createKeepAwake,
  installKeepAwake,
  KEEP_AWAKE_PUBLISH_CHANNEL,
  readKeepAwakeState,
  shouldStayAwake,
  type KeepAwakeState
} from './keepAwake'

type Log = string[]

function fakeBlocker(): { log: Log; blocker: Parameters<typeof createKeepAwake>[0] } {
  const log: Log = []
  const live = new Set<number>()
  let next = 1
  return {
    log,
    blocker: {
      start: (type) => {
        const id = next++
        live.add(id)
        log.push(`start ${type} -> ${id}`)
        return id
      },
      stop: (id) => {
        log.push(`stop ${id}`)
        return live.delete(id)
      },
      isStarted: (id) => live.has(id)
    }
  }
}

const state = (mode: KeepAwakeState['mode'], agentBusy = false): KeepAwakeState => ({ mode, agentBusy })

describe('shouldStayAwake', () => {
  it.each([
    ['on', false, true],
    ['on', true, true],
    ['agent', false, false],
    ['agent', true, true],
    ['off', false, false],
    ['off', true, false]
  ] as const)('%s with agent busy=%s -> %s', (mode, busy, expected) => {
    expect(shouldStayAwake(state(mode, busy))).toBe(expected)
  })
})

describe('createKeepAwake', () => {
  it('starts nothing until told to, and holds one assertion at most', () => {
    const { log, blocker } = fakeBlocker()
    const awake = createKeepAwake(blocker)
    awake.apply(state('agent'))
    expect(log).toEqual([])
    awake.apply(state('on'))
    awake.apply(state('on'))
    awake.apply(state('on', true))
    expect(log).toEqual(['start prevent-app-suspension -> 1'])
    expect(awake.blocking()).toBe(true)
  })

  it('follows the agents in agent mode, one start and one stop per edge', () => {
    const { log, blocker } = fakeBlocker()
    const awake = createKeepAwake(blocker)
    awake.apply(state('agent', true))
    awake.apply(state('agent', true))
    awake.apply(state('agent', false))
    awake.apply(state('agent', false))
    awake.apply(state('agent', true))
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1', 'start prevent-app-suspension -> 2'])
  })

  it('lets go when switched off, whatever the agents are doing', () => {
    const { log, blocker } = fakeBlocker()
    const awake = createKeepAwake(blocker)
    awake.apply(state('on', true))
    awake.apply(state('off', true))
    awake.apply(state('off', false))
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
    expect(awake.blocking()).toBe(false)
  })

  it('keeps the assertion across a mode change that still wants it', () => {
    const { log, blocker } = fakeBlocker()
    const awake = createKeepAwake(blocker)
    awake.apply(state('agent', true))
    awake.apply(state('on', true))
    awake.apply(state('on', false))
    awake.apply(state('agent', false))
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
  })

  it('releases on demand, once', () => {
    const { log, blocker } = fakeBlocker()
    const awake = createKeepAwake(blocker)
    awake.apply(state('on'))
    awake.release()
    awake.release()
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
  })
})

describe('readKeepAwakeState', () => {
  it('rebuilds a well-formed message from its two fields', () => {
    expect(readKeepAwakeState({ mode: 'agent', agentBusy: true, extra: 1 })).toEqual({ mode: 'agent', agentBusy: true })
  })

  it.each([null, 'on', { mode: 'always', agentBusy: false }, { mode: 'on' }, { mode: 'on', agentBusy: 'yes' }])(
    'refuses %j',
    (value) => {
      expect(readKeepAwakeState(value)).toBeNull()
    }
  )
})

describe('installKeepAwake', () => {
  function rig(): { log: Log; publish: (payload: unknown, mainFrame?: boolean) => void; destroy: () => void } {
    const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>()
    const ipc = {
      on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) =>
        listeners.set(channel, listener),
      removeAllListeners: (channel: string) => listeners.delete(channel)
    } as unknown as IpcMain
    let onDestroyed: (() => void) | null = null
    const sender = {
      isDestroyed: () => false,
      once: (_event: string, listener: () => void) => {
        onDestroyed = listener
      }
    }
    const { log, blocker } = fakeBlocker()
    installKeepAwake(ipc, { blocker, fromMainFrame: (event) => (event as unknown as { main: boolean }).main })
    return {
      log,
      publish: (payload, mainFrame = true) =>
        listeners.get(KEEP_AWAKE_PUBLISH_CHANNEL)?.({ sender, main: mainFrame } as unknown as IpcMainEvent, payload),
      destroy: () => onDestroyed?.()
    }
  }

  it('applies what the window publishes', () => {
    const { log, publish } = rig()
    publish({ mode: 'on', agentBusy: false })
    publish({ mode: 'off', agentBusy: false })
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
  })

  it('ignores a message that is not from the main frame, or not a state', () => {
    const { log, publish } = rig()
    publish({ mode: 'on', agentBusy: false }, false)
    publish({ mode: 'forever', agentBusy: false })
    expect(log).toEqual([])
  })

  it('lets go when the window that asked is gone', () => {
    const { log, publish, destroy } = rig()
    publish({ mode: 'on', agentBusy: false })
    destroy()
    expect(log).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
  })
})
