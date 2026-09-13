import { describe, expect, it, vi } from 'vitest'
import { createQuitSequence } from './quitSequence'

/** A teardown that finishes when the test says so, and says whether it ran. */
function pendingStop(): { stop: () => Promise<void>; calls: () => number; finish: () => void; fail: () => void } {
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined
  let calls = 0
  return {
    stop: () => {
      calls += 1
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    calls: () => calls,
    finish: () => settle?.resolve(),
    fail: () => settle?.reject(new Error('the socket would not close'))
  }
}

describe('quitting while the runtime is still letting go', () => {
  it('holds the first quit back and starts the teardown', () => {
    const teardown = pendingStop()
    const quit = vi.fn()
    const preventDefault = vi.fn()

    createQuitSequence({ stop: teardown.stop, quit })({ preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(teardown.calls()).toBe(1)
    expect(quit).not.toHaveBeenCalled()
  })

  // The one this file exists for. A Mac user who presses ⌘Q, sees the window
  // sit there while the PTYs are killed, and presses it again used to end the
  // process mid-flush — which costs every open pane its transcript.
  it('holds a second quit back too, and does not tear down twice', () => {
    const teardown = pendingStop()
    const quit = vi.fn()
    const onBeforeQuit = createQuitSequence({ stop: teardown.stop, quit })

    const first = { preventDefault: vi.fn() }
    const second = { preventDefault: vi.fn() }
    onBeforeQuit(first)
    onBeforeQuit(second)

    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(teardown.calls()).toBe(1)
    expect(quit).not.toHaveBeenCalled()
  })

  it('asks for the quit once the teardown is done, and lets that one through', async () => {
    const teardown = pendingStop()
    const quit = vi.fn()
    const onBeforeQuit = createQuitSequence({ stop: teardown.stop, quit })

    onBeforeQuit({ preventDefault: vi.fn() })
    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    // Electron emits `before-quit` again for the quit just asked for, and that
    // is the one quit that must not be prevented — otherwise the app can never
    // leave at all.
    const final = { preventDefault: vi.fn() }
    onBeforeQuit(final)
    expect(final.preventDefault).not.toHaveBeenCalled()
  })

  // An app that cannot be quit is a worse failure than a workspace file that
  // could not be written, and a rejection that escaped here would be an
  // unhandled one in the main process on the way out.
  it('still quits when the teardown fails, and says why once', async () => {
    const teardown = pendingStop()
    const quit = vi.fn()
    const onProblem = vi.fn()
    const onBeforeQuit = createQuitSequence({ stop: teardown.stop, quit, onProblem })

    onBeforeQuit({ preventDefault: vi.fn() })
    teardown.fail()

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(onProblem).toHaveBeenCalledTimes(1)
    expect((onProblem.mock.calls[0]?.[0] as Error).message).toContain('socket')
  })
})
