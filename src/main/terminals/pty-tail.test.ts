import { spawn } from 'node-pty'
import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverTailOnTeardown } from './pty-tail'
import { canSpawnPty } from './pty-test-support'

// The recovery is a POSIX file descriptor's, so it is proved against a real one.
const describePty = process.platform !== 'win32' && canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const LINES = 400
const open: IPty[] = []

function run(command: string): IPty {
  const handle = spawn('/bin/sh', ['-c', command], {
    name: 'xterm-256color',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    env: { ...process.env } as Record<string, string>
  })
  open.push(handle)
  return handle
}

afterEach(() => {
  for (const handle of open.splice(0)) {
    try {
      handle.kill()
    } catch {
      // Already reaped by the test itself.
    }
  }
})

describePty('recoverTailOnTeardown', () => {
  it(
    'recovers output that node-pty closed the pty without ever delivering',
    async () => {
      // A reader that stops before the pty is empty is the accident behind the
      // lost tail; here it is made deliberate, so the state that used to happen
      // one run in five happens every run. The command's output outlives what a
      // stopped socket can hold, so the last line is still in the kernel when
      // node-pty closes the descriptor on its own timer — which is precisely
      // the moment the tail used to disappear.
      const handle = run(`for i in $(seq 1 ${LINES}); do echo "tail line $i"; done`)
      const recovered: string[] = []
      recoverTailOnTeardown(handle, process.platform, (chunk) => recovered.push(chunk))
      handle.pause()

      await new Promise<void>((resolve) => {
        handle.onExit(() => resolve())
      })

      expect(recovered.join('')).toContain(`tail line ${LINES}`)
    },
    TEST_TIMEOUT_MS
  )
})

describe('recoverTailOnTeardown on handles it cannot read', () => {
  it('leaves a Windows pty exactly as node-pty built it', () => {
    const destroy = (): void => {}
    const handle = { _fd: 7, _socket: { destroy } }

    recoverTailOnTeardown(handle as unknown as IPty, 'win32', () => {})

    expect(handle._socket.destroy).toBe(destroy)
  })

  it('gives the handle back untouched once the session is done with it', () => {
    const destroy = (): void => {}
    const handle = { _fd: 7, _socket: { destroy } }

    recoverTailOnTeardown(handle as unknown as IPty, 'linux', () => {}).dispose()

    expect(handle._socket.destroy).toBe(destroy)
  })

  it('leaves a handle whose internals it does not recognise alone', () => {
    const handle = { somethingElse: true }

    expect(() => recoverTailOnTeardown(handle as unknown as IPty, 'linux', () => {})).not.toThrow()
  })
})
