// The runbook said "quit teamree and open it again, on both machines, after the
// last pull". These are the tests that delete that step, so the first one uses
// a real checkout and a real filesystem watch: a fake would prove the class
// calls its own callback and nothing about whether a key landing in the
// directory ever reaches this process.

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
  // The failure this whole file is about, made deterministic: the platform
  // delivers nothing at all, and the roster still has to stop being stale.
  //
  // On the macOS runner this is not hypothetical — the three tests above fail
  // there as silence and have never failed on Linux. The fake below simply
  // never calls anybody back, which is that platform's behaviour with the
  // timing taken out of it.
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
    // The cost of the floor, stated: four steps from the short delay after an
    // attach to half a minute, and no further.
    const fake = fakeWatches()
    const clock = fakeClock()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch, sweep: clock.sweep })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    for (let sweeps = 0; sweeps < 6; sweeps += 1) clock.tick()
    expect(clock.delays).toEqual([
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

  it('starts over from the short delay when a watch has just been attached', () => {
    // Attaching is the moment an event is most likely to be lost — on darwin a
    // new handle rebuilds the stream every other watch in the process is
    // listening on — so the backoff is not something to have already spent.
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
    clock.tick()
    clock.tick()
    expect(clock.delays.at(-1)).toBe(3_200)

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
    // The filter used to read the event's filename, and the filename is the one
    // thing here that is not the same on two platforms. Two CI failures, two
    // guesses at the string, and both guesses rested on a description of macOS
    // that libuv's own `fsevents.c` contradicts — see the note beside the filter.
    //
    // So the names below are deliberately the wrong shape on purpose: an
    // absolute path, an empty string, and nothing at all. What the watcher
    // reports on is what `.teamree` actually did.
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

    // Nothing has happened to `.teamree` yet, and these are the checkout's own
    // churn — a build writing where builds write.
    fake.fire(root, 'node_modules/.vite/deps/chunk.js')
    fake.fire(root, '')
    run?.()
    expect(reports).toBe(0)

    // Now it genuinely arrives, and the event is named the least helpful way
    // available: the absolute path of a file three levels down.
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
    // What the root watch has to be able to say on its own, whichever of the
    // three is the one that speaks. A key landing in `members/` changes that
    // directory's mtime and leaves `.teamree`'s alone, so a mark of `.teamree`
    // by itself said nothing had happened, and one CI failure came of exactly
    // that. Only the root watch is fired here, deliberately.
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

    // And the relay file, which changes neither directory's mtime: editing a
    // file leaves its parent alone, so this is the third thing to mark.
    await writeFile(join(root, '.teamree', 'relay'), 'wss://relay.example/v1/relay\n', 'utf8')
    fake.fire(root, null)
    run?.()
    expect(reports).toBe(2)

    watcher.close()
  })

  it('does not cost a roster read for a build writing in the checkout', async () => {
    // The reason the checkout root is filtered at all. A checkout is where an
    // agent works and a build writes, and a report per file would mean reading
    // and parsing the roster thousands of times for events that have nothing to
    // do with it.
    //
    // A real directory rather than a made-up path, because the filter now asks
    // the filesystem what `.teamree` did instead of reading the event's name,
    // and a path that does not exist cannot answer that question honestly.
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
    // A branch switch that removes `.teamree` kills its watches, and a dying
    // watch is what marks a project unwatched. The directory comes back on the
    // way out of that branch and every watch re-attaches — so the warning has to
    // go with it.
    //
    // Leaving it standing is this area's own failure pointed the other way: the
    // thing worth warning about is a roster that has quietly stopped following
    // its file, and a warning left over a roster that is being followed is how
    // somebody learns to ignore it.
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
