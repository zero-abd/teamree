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
 * The error the sequence reported first. `calls[0]?.[0].message` on a spy never
 * called throws a TypeError naming neither the spy nor the expectation.
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

  // A second ⌘Q at a window that looks stuck used to end the process mid-flush.
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

    // Electron emits `before-quit` again for the quit just asked for; that one must not be prevented.
    const final = { preventDefault: vi.fn() }
    onBeforeQuit(final)
    expect(final.preventDefault).not.toHaveBeenCalled()
  })

  // An app that cannot be quit is the worse failure.
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

// A quit before the launch has finished: panes running, no handle to kill them yet.
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

    // Held, and nothing torn down yet.
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(teardown.calls()).toBe(0)

    launch.finish()
    await vi.waitFor(() => expect(teardown.calls()).toBe(1))
    expect(quit).not.toHaveBeenCalled()

    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })

  // A launch that hangs must not take the quit key with it.
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

    // The teardown runs anyway: a launch part-way through may have left something reachable.
    await vi.waitFor(() => expect(teardown.calls()).toBe(1))
    teardown.finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    // This is the one quit that can leave a pty running.
    expect(onProblem).toHaveBeenCalledTimes(1)
    expect(firstProblem(onProblem).message).toContain('had not finished')
  })

  // A launch that failed is over; the failure belongs to whoever started it.
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

describe('asking the window about unsaved files first', () => {
  it('stops nothing and quits nothing when the window says Cancel, and asks again next time', async () => {
    const stop = vi.fn(async () => {})
    const quit = vi.fn()
    const mayQuit = vi.fn(async () => false)
    const onBeforeQuit = createQuitSequence({ stop, quit, mayQuit })

    onBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(mayQuit).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(stop).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()

    const again = { preventDefault: vi.fn() }
    onBeforeQuit(again)
    expect(again.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(mayQuit).toHaveBeenCalledTimes(2))
  })

  it('tears down and quits once the window has saved or discarded', async () => {
    const stop = vi.fn(async () => {})
    const quit = vi.fn()
    createQuitSequence({ stop, quit, mayQuit: async () => true })({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
