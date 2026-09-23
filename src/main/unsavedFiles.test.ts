import { EventEmitter } from 'node:events'
import type { IpcMainEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installUnsavedFiles,
  readUnsavedPaths,
  UNSAVED_ANSWER_CHANNEL,
  UNSAVED_ASK_CHANNEL,
  UNSAVED_PUBLISH_CHANNEL
} from './unsavedFiles'

type Listener = (event: IpcMainEvent, payload: unknown) => void

function harness() {
  const listeners = new Map<string, Listener>()
  const ipc = { on: (channel: string, listener: Listener) => listeners.set(channel, listener) }
  const window = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
  const sender = window as unknown as WebContents
  const setEdited = vi.fn()
  const unsaved = installUnsavedFiles(ipc as never, { setEdited, fromMainFrame: () => true })
  const event = { sender } as IpcMainEvent
  return {
    unsaved,
    window,
    setEdited,
    publish: (paths: unknown) => listeners.get(UNSAVED_PUBLISH_CHANNEL)?.(event, paths),
    answer: (payload: unknown) => listeners.get(UNSAVED_ANSWER_CHANNEL)?.(event, payload)
  }
}

describe('unsaved files in the main process', () => {
  it('reads only a list of path strings', () => {
    expect(readUnsavedPaths(['src/a.ts'])).toEqual(['src/a.ts'])
    expect(readUnsavedPaths(['src/a.ts', 3])).toBeNull()
    expect(readUnsavedPaths('src/a.ts')).toBeNull()
  })

  it('draws the edited dot while anything is unsaved', () => {
    const { publish, setEdited, unsaved } = harness()
    publish(['src/math.ts'])
    expect(setEdited).toHaveBeenLastCalledWith(expect.anything(), true)
    expect(unsaved.paths()).toEqual(['src/math.ts'])
    publish([])
    expect(setEdited).toHaveBeenLastCalledWith(expect.anything(), false)
  })

  it('lets a quit through at once with nothing edited', async () => {
    const { unsaved, window } = harness()
    expect(await unsaved.ask('quit')).toBe(true)
    expect(window.send).not.toHaveBeenCalled()
  })

  it('asks the window once and goes by its answer', async () => {
    const { publish, answer, unsaved, window } = harness()
    publish(['src/math.ts'])
    const first = unsaved.ask('quit')
    const second = unsaved.ask('close')
    expect(window.send).toHaveBeenCalledTimes(1)
    expect(window.send).toHaveBeenCalledWith(UNSAVED_ASK_CHANNEL, { id: 1, reason: 'quit' })
    answer({ id: 1, proceed: false })
    expect(await first).toBe(false)
    expect(await second).toBe(false)
  })

  it('lets go when the window goes, or a forced quit releases it', async () => {
    const { publish, unsaved, window } = harness()
    publish(['src/math.ts'])
    const gone = unsaved.ask('quit')
    window.emit('destroyed')
    expect(await gone).toBe(true)

    const again = harness()
    again.publish(['src/math.ts'])
    const forced = again.unsaved.ask('quit')
    again.unsaved.release()
    expect(await forced).toBe(true)
  })
})
