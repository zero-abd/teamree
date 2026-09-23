// The tests that delete "quit teamree and open it again after the last pull".
// The first ones use a real checkout and a real filesystem watch: a fake proves
// nothing about whether a key landing in the directory reaches this process.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMemberFile, MEMBERS_DIR_SEGMENTS } from './memberFile'
import { readRoster } from './roster'
import {
  DEFAULT_SWEEP_FROM_MS,
  DEFAULT_SWEEP_UNTIL_MS,
  degradedTeamreeWatchReport,
  TeamreeWatcher,
  type WatchFn,
  type WatchHandle
} from './teamreeWatcher'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamree-watch-'))
  roots.push(root)
  return root
}

/** A key landing the way `git pull` lands one: a whole file, at once. */
async function writeMemberFile(root: string, handle: string): Promise<void> {
  await mkdir(join(root, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
  await writeFile(
    join(root, ...MEMBERS_DIR_SEGMENTS, `${handle}.pub`),
    formatMemberFile({ handle, publicKey: Buffer.alloc(32, handle).toString('base64'), addedAt: '2026-01-01' }),
    'utf8'
  )
}

/** Resolves on the first report, or rejects rather than hanging the suite. */
function reported(waitMs = 5_000): { onChange: () => void; happened: Promise<void> } {
  let announce = (): void => {}
  const happened = new Promise<void>((resolve, reject) => {
    announce = resolve
    const timer = setTimeout(() => reject(new Error('nothing was reported')), waitMs)
    timer.unref?.()
  })
  return { onChange: () => announce(), happened }
}

describe('noticing what git brought in', () => {
  it('sees a teammate’s key arrive by git pull, without being restarted', async () => {
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const { onChange, happened } = reported()
    const watcher = new TeamreeWatcher({ onChange, settleMs: 10 })
    watcher.sync([{ id: 'p1', path: root }])
    try {
      // The pull, after the app has been running for a while with a roster of
      // one. Nothing asks teamree to look.
      await writeMemberFile(root, 'bo')
      await happened
      const roster = await readRoster(root)
      expect(roster.entries.map((entry) => entry.handle)).toEqual(['ana', 'bo'])
    } finally {
      watcher.close()
    }
  })

  it('sees the relay file arrive in a project that had no .teamree at all', async () => {
    // The leader's first push of step 3: the directory itself is what appears,
    // so the watch that catches it is the one on the checkout root.
    const root = await checkout()
    const { onChange, happened } = reported()
    const watcher = new TeamreeWatcher({ onChange, settleMs: 10 })
    watcher.sync([{ id: 'p1', path: root }])
    try {
      await mkdir(join(root, '.teamree'), { recursive: true })
      await writeFile(join(root, '.teamree', 'relay'), 'wss://relay.example/v1/relay\n', 'utf8')
      await happened
    } finally {
      watcher.close()
    }
  })

  it('keeps following a .teamree that a branch switch removed and brought back', async () => {
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const first = reported()
    const watcher = new TeamreeWatcher({ onChange: () => first.onChange(), settleMs: 10 })
    watcher.sync([{ id: 'p1', path: root }])
    try {
      await rm(join(root, '.teamree'), { recursive: true, force: true })
      await first.happened
      // The watch on members/ died with the directory. What has to survive is
      // the app's ability to hear the directory come back.
      const second = reported()
      const again = new TeamreeWatcher({ onChange: () => second.onChange(), settleMs: 10 })
      again.sync([{ id: 'p1', path: root }])
      try {
        await writeMemberFile(root, 'bo')
        await second.happened
      } finally {
        again.close()
      }
    } finally {
      watcher.close()
    }
  })
})

/** A watch set driven by hand, so the bookkeeping is asserted rather than timed. */
function fakeWatches(): {
  watch: WatchFn
  fire: (target: string, relative: string | null) => void
  fail: (target: string, error: unknown) => void
  refuse: (target: string, error: NodeJS.ErrnoException) => void
  allow: (target: string) => void
} {
  const listeners = new Map<string, Parameters<WatchFn>[0]>()
  const refusals = new Map<string, unknown>()
  const watch: WatchFn = (options): WatchHandle => {
    const refusal = refusals.get(options.target)
    if (refusal) throw refusal
    listeners.set(options.target, options)
    return {
      close: () => {
        listeners.delete(options.target)
      }
    }
  }
  return {
    watch,
    fire: (target, relative) => listeners.get(target)?.onChange(relative),
    fail: (target, error) => listeners.get(target)?.onError(error),
    refuse: (target, error) => refusals.set(target, error),
    allow: (target) => refusals.delete(target)
  }
}

/** The sweep's clock, driven by hand: what delay it asked for, and when it runs. */
function fakeClock(): { sweep: (run: () => void, delayMs: number) => () => void; delays: number[]; tick: () => void } {
  const delays: number[] = []
  let pending: (() => void) | undefined
  return {
    delays,
    sweep: (run, delayMs) => {
      delays.push(delayMs)
      pending = run
      return () => {
        pending = undefined
      }
    },
    tick: () => {
      const run = pending
      pending = undefined
      run?.()
    }
  }
}

describe('the sweep under the watch', () => {
  // The failure this file is about, made deterministic: the platform delivers
  // nothing. Measured on a mac with every raw `fs.watch` callback logged: in
  // three runs out of eight no handle spoke at all; under load, nine in ten.
  it('notices a key that no watch ever mentioned', async () => {
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const fake = fakeWatches()
    const clock = fakeClock()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      sweep: clock.sweep,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])

    // The pull lands, and not one of the three watches says so.
    await writeMemberFile(root, 'bo')
    clock.tick()
    run?.()
    expect(reports).toBe(1)

    // And the relay file, which changes neither directory's mtime.
    await writeFile(join(root, '.teamree', 'relay'), 'wss://relay.example/v1/relay\n', 'utf8')
    clock.tick()
    run?.()
    expect(reports).toBe(2)

    watcher.close()
  })

  it('says nothing at all while nothing is happening', async () => {
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const fake = fakeWatches()
    const clock = fakeClock()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      sweep: clock.sweep,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])
    for (let sweeps = 0; sweeps < 5; sweeps += 1) {
      clock.tick()
      run?.()
    }
    expect(reports).toBe(0)
    watcher.close()
  })

  it('backs off, so a project nothing is happening to is not being polled', () => {
    // A run of close sweeps over the window a fresh handle is deaf for, then
    // four steps to half a minute. The close run is not negotiable: on darwin
    // the event that would have covered the difference is the one that was lost.
    const fake = fakeWatches()
    const clock = fakeClock()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, sweep: clock.sweep })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    for (let sweeps = 0; sweeps < 11; sweeps += 1) clock.tick()
    expect(clock.delays).toEqual([
      DEFAULT_SWEEP_FROM_MS,
      DEFAULT_SWEEP_FROM_MS,
      DEFAULT_SWEEP_FROM_MS,
      DEFAULT_SWEEP_FROM_MS,
      DEFAULT_SWEEP_FROM_MS,
      DEFAULT_SWEEP_FROM_MS,
      800,
      3_200,
      12_800,
      DEFAULT_SWEEP_UNTIL_MS,
      DEFAULT_SWEEP_UNTIL_MS,
      DEFAULT_SWEEP_UNTIL_MS
    ])
    watcher.close()
  })

  it('does not back off while it is still the thing finding the changes', async () => {
    // A sweep that finds something no watch mentioned is evidence about the
    // watch, so the answer is to stay close until things go quiet, not back off.
    const root = await checkout()
    const fake = fakeWatches()
    const clock = fakeClock()
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      sweep: clock.sweep,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])
    // Nothing happens for long enough that the backoff has been spent.
    for (let sweeps = 0; sweeps < 8; sweeps += 1) clock.tick()
    expect(clock.delays.at(-1)).toBe(12_800)

    // Then the pull lands, and not one watch says so.
    await writeMemberFile(root, 'ana')
    clock.tick()
    run?.()
    expect(clock.delays.at(-1)).toBe(DEFAULT_SWEEP_FROM_MS)
    watcher.close()
  })

  it('sweeps closely again when a watch dies, because that is when nothing is listening', () => {
    // A branch switch that removes `.teamree` kills two watches; leaving the
    // backoff where it was left the project half a minute behind its own checkout.
    const fake = fakeWatches()
    const clock = fakeClock()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, sweep: clock.sweep })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    for (let sweeps = 0; sweeps < 8; sweeps += 1) clock.tick()
    expect(clock.delays.at(-1)).toBe(12_800)

    fake.fail(join('/repo', '.teamree'), Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(clock.delays.at(-1)).toBe(DEFAULT_SWEEP_FROM_MS)

    // And a watch that dies noisily cannot keep pushing the sweep out ahead of
    // itself: the handle is already gone the second time.
    const armed = clock.delays.length
    fake.fail(join('/repo', '.teamree'), new Error('and again'))
    expect(clock.delays.length).toBe(armed)
    watcher.close()
  })

  it('finds a key that landed after the first sweep had already looked', async () => {
    // The failing case on macOS: the watch delivers nothing and the one sweep
    // after the attach runs a moment too early. What followed was 800ms of
    // silence, then 3.2s, then 12.8s.
    const root = await checkout()
    const fake = fakeWatches()
    const clock = fakeClock()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      sweep: clock.sweep,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])

    // The sweep looks before the pull has landed, and finds the checkout as it
    // was. It must not treat that as a reason to look less often.
    clock.tick()
    expect(reports).toBe(0)
    expect(clock.delays.at(-1)).toBe(DEFAULT_SWEEP_FROM_MS)

    await writeMemberFile(root, 'ana')
    clock.tick()
    run?.()
    expect(reports).toBe(1)
    watcher.close()
  })

  it('starts over from the short delay when a watch has just been attached', () => {
    // Attaching is the moment an event is most likely lost: on darwin a new
    // handle rebuilds the stream every other watch in the process listens on.
    const fake = fakeWatches()
    const clock = fakeClock()
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    fake.refuse(join('/repo', '.teamree'), missing)
    fake.refuse(join('/repo', '.teamree', 'members'), missing)
    const watcher = new TeamreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      sweep: clock.sweep,
      schedule: (task) => {
        task()
        return () => {}
      }
    })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    for (let sweeps = 0; sweeps < 8; sweeps += 1) clock.tick()
    expect(clock.delays.at(-1)).toBe(12_800)

    // `.teamree` has appeared, so the next `sync` attaches a watch on it.
    fake.allow(join('/repo', '.teamree'))
    watcher.sync([{ id: 'p1', path: '/repo' }])
    expect(clock.delays.at(-1)).toBe(DEFAULT_SWEEP_FROM_MS)
    watcher.close()
  })

  it('stops sweeping a project it is no longer watching, and stops when closed', () => {
    const fake = fakeWatches()
    const clock = fakeClock()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, sweep: clock.sweep })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    const armed = clock.delays.length
    watcher.sync([])
    clock.tick()
    expect(clock.delays.length).toBe(armed)
    watcher.close()
    clock.tick()
    expect(clock.delays.length).toBe(armed)
  })
})

describe('the watch set', () => {
  it('reports a burst of files once rather than a roster read per key', () => {
    const fake = fakeWatches()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    fake.fire(join('/repo', '.teamree', 'members'), 'ana.pub')
    fake.fire(join('/repo', '.teamree', 'members'), 'bo.pub')
    expect(reports).toBe(0)
    run?.()
    expect(reports).toBe(1)
    watcher.close()
  })

  it('reports on what .teamree did, whatever the platform called the event', async () => {
    // The filter used to read the event's filename, which differs between
    // platforms (libuv's `fsevents.c` contradicts the usual description of
    // macOS). So the names below are the wrong shape on purpose.
    const root = await checkout()
    const fake = fakeWatches()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])

    // Nothing has happened to `.teamree` yet: the checkout's own churn.
    fake.fire(root, 'node_modules/.vite/deps/chunk.js')
    fake.fire(root, '')
    run?.()
    expect(reports).toBe(0)

    // Now it genuinely arrives, named the least helpful way: an absolute path.
    await writeMemberFile(root, 'bo')
    fake.fire(root, join(root, '.teamree', 'members', 'bo.pub'))
    run?.()
    expect(reports).toBe(1)

    // And when it goes, with no filename at all.
    await rm(join(root, '.teamree'), { recursive: true, force: true })
    fake.fire(root, null)
    run?.()
    expect(reports).toBe(2)

    watcher.close()
  })

  it('catches a key arriving when only the checkout-root watch fires', async () => {
    // A key landing in `members/` changes that directory's mtime and leaves
    // `.teamree`'s alone, so a mark of `.teamree` alone said nothing had
    // happened (one CI failure). Only the root watch is fired here, deliberately.
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const fake = fakeWatches()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])

    await writeMemberFile(root, 'bo')
    fake.fire(root, null)
    run?.()
    expect(reports).toBe(1)

    // And the relay file, which changes neither directory's mtime.
    await writeFile(join(root, '.teamree', 'relay'), 'wss://relay.example/v1/relay\n', 'utf8')
    fake.fire(root, null)
    run?.()
    expect(reports).toBe(2)

    watcher.close()
  })

  it('does not cost a roster read for a build writing in the checkout', async () => {
    // A checkout is where a build writes, and a report per file would read the
    // roster thousands of times. A real directory, because the filter asks the
    // filesystem what `.teamree` did.
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const fake = fakeWatches()
    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    watcher.sync([{ id: 'p1', path: root }])

    for (const file of ['dist', 'node_modules', 'build/out.js', '.DS_Store']) fake.fire(root, file)
    run?.()
    expect(reports).toBe(0)

    watcher.close()
  })

  it('says a project is not watched rather than letting a stale roster look live', () => {
    const fake = fakeWatches()
    const degraded: string[] = []
    fake.refuse('/repo', Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
    const watcher = new TeamreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      onDegraded: (event) => degraded.push(degradedTeamreeWatchReport(event))
    })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    expect(watcher.watches('p1')).toBe(false)
    expect(degraded).toHaveLength(1)
    expect(degraded[0]).toContain('no filesystem watches left')
    // What it costs, not what broke: nothing here has broken.
    expect(degraded[0]).toContain('git pull')
    watcher.close()
  })

  it('stops saying a project is unwatched once its watches are back', async () => {
    // A dying watch marks a project unwatched; when the directory comes back and
    // every watch re-attaches, the warning has to go, or somebody learns to ignore it.
    const root = await checkout()
    await writeMemberFile(root, 'ana')
    const fake = fakeWatches()
    const watcher = new TeamreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      schedule: (task) => {
        task()
        return () => {}
      }
    })
    watcher.sync([{ id: 'p1', path: root }])
    expect(watcher.watches('p1')).toBe(true)

    // The watch on `.teamree` dies the way a removed directory kills one.
    fake.fail(join(root, '.teamree'), Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(watcher.watches('p1')).toBe(false)

    // And the project comes back: the directory is there and re-attaching works.
    watcher.sync([{ id: 'p1', path: root }])
    expect(watcher.watches('p1')).toBe(true)

    watcher.close()
  })

  it('treats a project with no .teamree yet as covered, because its parent is', () => {
    const fake = fakeWatches()
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    fake.refuse(join('/repo', '.teamree'), missing)
    fake.refuse(join('/repo', '.teamree', 'members'), missing)
    const degraded: unknown[] = []
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, onDegraded: (e) => degraded.push(e) })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    expect(watcher.watches('p1')).toBe(true)
    expect(degraded).toHaveLength(0)
    watcher.close()
  })

  it('says so once when a watch dies mid-flight, not on every report of it', () => {
    const fake = fakeWatches()
    const degraded: unknown[] = []
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, onDegraded: (e) => degraded.push(e) })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    fake.fail('/repo', Object.assign(new Error('watch died'), { code: 'ENOSPC' }))
    fake.fail(join('/repo', '.teamree'), new Error('and again'))
    expect(degraded).toHaveLength(1)
    expect(watcher.watches('p1')).toBe(false)
    watcher.close()
  })

  it('drops the watches of a project that is no longer in the list', () => {
    const fake = fakeWatches()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    expect(watcher.watchedIds).toEqual(['p1'])
    watcher.sync([])
    expect(watcher.watchedIds).toEqual([])
    expect(watcher.watches('p1')).toBe(false)
    watcher.close()
  })
})
