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
      // one run in five happens every run.
      //
      // The teardown is then triggered the way node-pty triggers it — by
      // destroying the socket — rather than by killing the child and waiting
      // for an exit. Two earlier versions waited for the child instead and both
      // hung on macOS for the whole timeout: with the reader stopped, how much
      // output fits before the child blocks, and when the platform reports the
      // exit at all, are properties of the platform rather than of the code
      // under test. What is under test is the last moment before the descriptor
      // closes, and this reaches exactly that moment on every platform.
      //
      // The end-to-end path — a real command, a real exit, no interference —
      // is covered by the volume test in pty-session.test.ts.
      const handle = run(`for i in $(seq 1 ${LINES}); do echo "tail line $i"; done; sleep 60`)
      const delivered: string[] = []
      handle.onData((chunk) => delivered.push(chunk))
      const recovered: string[] = []
      recoverTailOnTeardown(handle, process.platform, (chunk) => recovered.push(chunk))
      handle.pause()

      // Long enough for the child to write into the pty, short enough to stay
      // a test. Nothing is read out of it in the meantime.
      await new Promise<void>((resolve) => setTimeout(resolve, 500))

      const socket = (handle as unknown as { _socket: { destroy: () => void } })._socket
      socket.destroy()

      // Without the drain this is empty: the socket was stopped before any of
      // it was read, and the descriptor closes without anyone looking again.
      expect(recovered.join('')).toMatch(/tail line \d+/)
      expect(recovered.join('').length).toBeGreaterThan(delivered.join('').length)
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
