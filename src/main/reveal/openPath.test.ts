import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenPath, OPEN_PATH_CHANNEL, registerOpenPathHandler } from './openPath'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'teamree-open-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('open in default app', () => {
  it('opens a plain file and passes on what the OS said went wrong', async () => {
    await writeFile(path.join(dir, 'a.bin'), 'x')
    const openPath = vi.fn(async () => '')
    expect(await createOpenPath({ openPath })(path.join(dir, 'a.bin'))).toEqual({ revealed: true })
    expect(openPath).toHaveBeenCalledWith(path.join(dir, 'a.bin'))
    const refused = createOpenPath({ openPath: async () => 'no app' })
    expect(await refused(path.join(dir, 'a.bin'))).toEqual({ revealed: false, reason: 'no app' })
  })

  it('refuses a relative path, a missing file, a directory and an executable without asking the OS', async () => {
    await writeFile(path.join(dir, 'run.sh'), 'echo')
    await chmod(path.join(dir, 'run.sh'), 0o755)
    const openPath = vi.fn(async () => '')
    const open = createOpenPath({ openPath })
    for (const target of ['a.bin', path.join(dir, 'gone'), dir, path.join(dir, 'run.sh'), 42]) {
      expect((await open(target)).revealed).toBe(false)
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('answers only the main frame', async () => {
    let listener: ((event: never, path: unknown) => Promise<unknown>) | undefined
    registerOpenPathHandler(
      { handle: (channel, handler) => void (channel === OPEN_PATH_CHANNEL && (listener = handler as never)) },
      { openPath: async () => '', fromMainFrame: () => false }
    )
    expect(await listener?.({} as never, dir)).toEqual({ revealed: false, reason: 'not the window' })
  })
})
