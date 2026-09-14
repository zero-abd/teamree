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

/**
 * The error the sequence reported first, asserted to be there rather than
 * reached through an optional chain.
 *
 * `calls[0]?.[0]` reads as safe and is not: on a spy that was never called the
 * whole expression is `undefined` and the `.message` after it throws a
 * TypeError naming neither the spy nor the expectation. Every caller has just
 * asserted the call count, so the honest thing is to say so once, here, where a
 * failure can be explained.
 */
function firstProblem(onProblem: { mock: { calls: unknown[][] } }): Error {
  const [problem] = onProblem.mock.calls[0] ?? []
  if (!(problem instanceof Error)) throw new Error('the sequence reported no problem to read a message from')
  return problem
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
    expect(firstProblem(onProblem).message).toContain('socket')
  })
})

// The other end of the same loss: a quit pressed before the launch has
// finished, when the panes of the last session are already running and the
// handle that could kill them does not exist yet.
describe('quitting while the app is still starting up', () => {
  /** A launch the test finishes when it chooses, or never. */
  function pendingLaunch(): { whenStarted: () => Promise<void>; finish: () => void; fail: () => void } {
    let settle: { resolve: () => void; reject: (error: Error) => void } | undefined
    const launched = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    return {
      whenStarted: () => launched,
      finish: () => settle?.resolve(),
      fail: () => settle?.reject(new Error('the workspace file would not open'))
    }
  }

  it('holds the quit until the launch has finished, and only then tears down', async () => {
    const launch = pendingLaunch()
    const teardown = pendingStop()
    const quit = vi.fn()
    const preventDefault = vi.fn()

    createQuitSequence({ whenStarted: launch.whenStarted, stop: teardown.stop, quit })({ preventDefault })

    // Held, and nothing torn down yet: what would do the tearing down is what
    // the launch is still busy producing.
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(teardown.calls()).toBe(0)

    launch.finish()
    await vi.waitFor(() => expect(teardown.calls()).toBe(1))
    expect(quit).not.toHaveBeenCalled()

    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })

  // A launch that hangs must not take the quit key with it. The user gets a
  // pause and then a quit, which is a worse shutdown than a complete one and a
  // far better outcome than an app that cannot be left.
  it('stops waiting for a launch that is not coming back, and quits anyway', async () => {
    const neverStarts = new Promise<void>(() => {})
    const teardown = pendingStop()
    const quit = vi.fn()
    const onProblem = vi.fn()

    createQuitSequence({
      whenStarted: () => neverStarts,
      startupGraceMs: 10,
      stop: teardown.stop,
      quit,
      onProblem
    })({ preventDefault: vi.fn() })

    // The teardown runs anyway, because a launch part-way through may still
    // have left something reachable behind, and then the quit goes through.
    await vi.waitFor(() => expect(teardown.calls()).toBe(1))
    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    // Said out loud: this is the one quit that can leave a pty running, and
    // without a line here nothing would ever explain how.
    expect(onProblem).toHaveBeenCalledTimes(1)
    expect(firstProblem(onProblem).message).toContain('had not finished')
  })

  // A launch that failed is a launch that is over. The failure belongs to
  // whoever started it, and it says nothing about whether a pty is still
  // running — which one may well be.
  it('tears down and quits when the launch failed, without reporting it twice', async () => {
    const launch = pendingLaunch()
    const teardown = pendingStop()
    const quit = vi.fn()
    const onProblem = vi.fn()

    createQuitSequence({ whenStarted: launch.whenStarted, stop: teardown.stop, quit, onProblem })({
      preventDefault: vi.fn()
    })
    launch.fail()

    await vi.waitFor(() => expect(teardown.calls()).toBe(1))
    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(onProblem).not.toHaveBeenCalled()
  })
})
