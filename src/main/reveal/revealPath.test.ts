// What the user is told when "Reveal in Finder" cannot reveal anything.
//
// The OS call is silent on a missing path, so every one of these cases used to
// look identical from the outside: a button pressed and a screen that did not
// change. The assertions are therefore on the wording as much as on the
// outcome — a refusal that does not name the path it is about is no better than
// the silence it replaced.
//
// The happy paths run against a real temporary directory rather than a stubbed
// `exists`, because the fact under test is what the filesystem says, and a stub
// would only ever repeat what this file already believes.

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRevealPath,
  registerRevealHandler,
  REVEAL_PATH_CHANNEL,
  type RevealInvokeEvent,
  type RevealResult
} from './revealPath'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-reveal-'))
  dirs.push(dir)
  return dir
}

/** The OS call, replaced by a notebook. Nothing here opens a Finder window. */
function recorder(throwing?: Error): { shown: string[]; showItemInFolder: (target: string) => void } {
  const shown: string[] = []
  return {
    shown,
    showItemInFolder: (target: string) => {
      shown.push(target)
      if (throwing !== undefined) throw throwing
    }
  }
}

function refusal(result: RevealResult): string {
  expect(result.revealed).toBe(false)
  return result.revealed ? '' : result.reason
}

describe('revealing a path', () => {
  it('shows a file that is really there', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'notes.txt')
    await writeFile(file, 'something to reveal\n')
    const os1 = recorder()

    expect(await createRevealPath(os1)(file)).toEqual({ revealed: true })
    expect(os1.shown).toEqual([file])
  })

  it('shows a directory, which is what a worktree checkout is', async () => {
    const dir = await tempDir()
    const os1 = recorder()

    expect(await createRevealPath(os1)(dir)).toEqual({ revealed: true })
    expect(os1.shown).toEqual([dir])
  })

  // The case this module exists for: the checkout was deleted underneath the
  // app. `showItemInFolder` does nothing and says nothing about it, so the
  // refusal has to name the path and suggest what became of it.
  it('names the path that is not there rather than calling the OS and going quiet', async () => {
    const dir = await tempDir()
    const gone = path.join(dir, 'a-checkout-that-was-deleted')
    const os1 = recorder()

    const reason = refusal(await createRevealPath(os1)(gone))

    expect(reason).toContain(gone)
    expect(reason).toContain('There is nothing at')
    expect(reason).toContain('deleted or moved')
    expect(os1.shown).toEqual([])
  })

  it('refuses a relative path instead of resolving it against whatever the app was launched from', async () => {
    const os1 = recorder()

    const reason = refusal(await createRevealPath(os1)('src/main/reveal'))

    expect(reason).toContain('src/main/reveal')
    expect(reason).toContain('relative')
    expect(os1.shown).toEqual([])
  })

  it('refuses an empty path, and one that is not a string at all', async () => {
    const os1 = recorder()
    const reveal = createRevealPath(os1)

    expect(refusal(await reveal(''))).toContain('without being given one')
    expect(refusal(await reveal(null))).toContain('without being given one')
    expect(refusal(await reveal(42))).toContain('without being given one')
    expect(os1.shown).toEqual([])
  })

  it('turns a throw from the OS call into a reason rather than a crash', async () => {
    const dir = await tempDir()
    const os1 = recorder(new Error('Finder is not running'))

    const reason = refusal(await createRevealPath(os1)(dir))

    expect(reason).toContain(dir)
    expect(reason).toContain('Finder is not running')
    expect(reason).toContain('would not show')
  })

  // A symlink whose target has gone is still an entry the file manager can
  // select inside its parent folder, which is why existence is asked with
  // `lstat` and not `stat`.
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('shows a broken symlink, because the link itself is something to look at', async () => {
    const dir = await tempDir()
    const link = path.join(dir, 'dangling')
    await symlink(path.join(dir, 'never-existed'), link)
    const os1 = recorder()

    expect(await createRevealPath(os1)(link)).toEqual({ revealed: true })
    expect(os1.shown).toEqual([link])
  })

  it('honours an injected existence check instead of insisting on the filesystem', async () => {
    const os1 = recorder()
    const reveal = createRevealPath({ ...os1, exists: async () => true })

    expect(await reveal('/nowhere/at/all')).toEqual({ revealed: true })
    expect(os1.shown).toEqual(['/nowhere/at/all'])
  })
})

/** A stand-in for `ipcMain`, holding the one listener it was given. */
function fakeIpc(): {
  channels: string[]
  invoke: (event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>
  handle: (channel: string, listener: (event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>) => void
} {
  const channels: string[] = []
  let handler: ((event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>) | null = null
  return {
    channels,
    invoke: async (event, target) => {
      if (handler === null) throw new Error('nothing was registered')
      return handler(event, target)
    },
    handle: (channel, listener) => {
      channels.push(channel)
      handler = listener
    }
  }
}

const mainFrame = { name: 'main' }
const fromWindow: RevealInvokeEvent = { senderFrame: mainFrame, sender: { mainFrame } }
const fromSubframe: RevealInvokeEvent = { senderFrame: { name: 'an iframe' }, sender: { mainFrame } }

describe('the registered handler', () => {
  it('answers on the channel the preload spells out', async () => {
    const dir = await tempDir()
    const ipc = fakeIpc()
    const os1 = recorder()
    registerRevealHandler(ipc, os1)

    expect(ipc.channels).toEqual([REVEAL_PATH_CHANNEL])
    expect(await ipc.invoke(fromWindow, dir)).toEqual({ revealed: true })
    expect(os1.shown).toEqual([dir])
  })

  it('refuses a frame the window did not send, without touching the OS', async () => {
    const dir = await tempDir()
    const ipc = fakeIpc()
    const os1 = recorder()
    registerRevealHandler(ipc, {
      ...os1,
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })

    const reason = refusal(await ipc.invoke(fromSubframe, dir))

    expect(reason).toContain('when the window itself asks')
    expect(os1.shown).toEqual([])
    expect(await ipc.invoke(fromWindow, dir)).toEqual({ revealed: true })
  })

  it('carries a refusal back over the channel instead of rejecting the invoke', async () => {
    const dir = await tempDir()
    const gone = path.join(dir, 'moved-away')
    const ipc = fakeIpc()
    registerRevealHandler(ipc, recorder())

    expect(refusal(await ipc.invoke(fromWindow, gone))).toContain(gone)
  })
})
