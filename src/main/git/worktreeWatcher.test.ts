import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import {
  degradedWatchReport,
  ignoresCheckoutChange,
  ignoresGitDirChange,
  resolveGitDir,
  WorktreeWatcher,
  type WatchDegraded,
  type WatchFn,
  type WatchHandle
} from './worktreeWatcher'

/** What the kernel hands back once this user has no inotify instances left. */
function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })
}

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId: 'project',
    name: id,
    branch: `teamree/${id}`,
    path: `/checkouts/${id}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0,
    ...overrides
  }
}

/** A watch implementation that records what was asked for and can be fired. */
function createFakeWatch(): {
  watch: WatchFn
  targets: () => string[]
  open: () => number
  fire: (target: string, relative: string | null) => void
  fail: (target: string, error: unknown) => void
  throwOn: (predicate: (target: string, recursive: boolean) => boolean) => void
} {
  type Entry = {
    target: string
    recursive: boolean
    onChange: (relative: string | null) => void
    onError: (error: unknown) => void
    closed: boolean
  }
  const entries: Entry[] = []
  let refuse: (target: string, recursive: boolean) => boolean = () => false

  const find = (target: string): Entry => {
    const entry = entries.find((candidate) => candidate.target === target && !candidate.closed)
    if (!entry) throw new Error(`nothing is watching ${target}`)
    return entry
  }

  return {
    watch: (options): WatchHandle => {
      if (refuse(options.target, options.recursive)) throw new Error(`cannot watch ${options.target}`)
      const entry: Entry = { ...options, closed: false }
      entries.push(entry)
      return {
        close: () => {
          entry.closed = true
        }
      }
    },
    targets: () => entries.filter((entry) => !entry.closed).map((entry) => entry.target),
    open: () => entries.filter((entry) => !entry.closed).length,
    fire: (target, relative) => find(target).onChange(relative),
    fail: (target, error) => find(target).onError(error),
    throwOn: (predicate) => {
      refuse = predicate
    }
  }
}

/** A clock and a scheduler under the test's control, never the event loop's. */
function createClock(): {
  now: () => number
  advance: (ms: number) => void
  schedule: (run: () => void, delayMs: number) => () => void
  pending: () => number
} {
  let time = 0
  let queue: { at: number; run: () => void }[] = []
  return {
    now: () => time,
    advance: (ms) => {
      time += ms
      const due = queue.filter((entry) => entry.at <= time)
      queue = queue.filter((entry) => entry.at > time)
      for (const entry of due) entry.run()
    },
    schedule: (run, delayMs) => {
      const entry = { at: time + delayMs, run }
      queue.push(entry)
      return () => {
        queue = queue.filter((candidate) => candidate !== entry)
      }
    },
    pending: () => queue.length
  }
}

describe('ignoresCheckoutChange', () => {
  it('ignores the two directories that are pure churn', () => {
    expect(ignoresCheckoutChange('node_modules/react/index.js')).toBe(true)
    expect(ignoresCheckoutChange('.git/objects/ab/cdef')).toBe(true)
    expect(ignoresCheckoutChange(path.join('packages', 'app', 'node_modules', 'x'))).toBe(true)
  })

  it('keeps build output, because some repositories track it', () => {
    for (const candidate of ['dist/app.js', 'build/index.html', 'target/debug/app', 'out/main/index.js']) {
      expect(ignoresCheckoutChange(candidate)).toBe(false)
    }
  })

  it('ignores editor droppings but not the files they shadow', () => {
    expect(ignoresCheckoutChange('src/App.tsx~')).toBe(true)
    expect(ignoresCheckoutChange('src/.#App.tsx')).toBe(true)
    expect(ignoresCheckoutChange('.DS_Store')).toBe(true)
    expect(ignoresCheckoutChange('src/App.tsx')).toBe(false)
  })

  it('treats an unnamed change as a change, because something did happen', () => {
    expect(ignoresCheckoutChange(null)).toBe(false)
  })

  it('reads a path in either separator, since the OS picks', () => {
    expect(ignoresCheckoutChange('packages\\app\\node_modules\\x')).toBe(true)
    expect(ignoresCheckoutChange('packages\\app\\src\\index.ts')).toBe(false)
  })
})

describe('ignoresGitDirChange', () => {
  it('lets through what actually moves a status', () => {
    for (const candidate of ['index', 'HEAD', 'MERGE_HEAD', 'packed-refs', 'refs/heads/main', 'logs/HEAD']) {
      expect(ignoresGitDirChange(candidate)).toBe(false)
    }
  })

  it('drops object writes and lock files', () => {
    expect(ignoresGitDirChange('objects/ab/cdef1234')).toBe(true)
    expect(ignoresGitDirChange('index.lock')).toBe(true)
    expect(ignoresGitDirChange('refs/heads/main.lock')).toBe(true)
    expect(ignoresGitDirChange('COMMIT_EDITMSG')).toBe(true)
  })
})

describe('WorktreeWatcher', () => {
  const created: string[] = []
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('watches a ready worktree twice: its checkout and its git directory', () => {
    const fake = createFakeWatch()
    const watcher = new WorktreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      resolveGitDir: (checkout) => path.join(checkout, '.git-dir')
    })

    watcher.sync([worktree('a')])

    expect(fake.targets()).toEqual(['/checkouts/a', path.join('/checkouts/a', '.git-dir')])
    expect(watcher.watchedIds).toEqual(['a'])
    expect(watcher.watchesWorkingTree('a')).toBe(true)
  })

  it('leaves alone a worktree that is not ready yet, and picks it up when it is', () => {
    const fake = createFakeWatch()
    const watcher = new WorktreeWatcher({ onChange: () => {}, watch: fake.watch, resolveGitDir: () => undefined })

    watcher.sync([worktree('a', { state: 'creating' }), worktree('b', { state: 'failed' })])
    expect(watcher.watchedIds).toEqual([])

    watcher.sync([worktree('a'), worktree('b', { state: 'failed' })])
    expect(watcher.watchedIds).toEqual(['a'])
  })

  it('stops watching a worktree that is gone, and rewatches one that moved', () => {
    const fake = createFakeWatch()
    const watcher = new WorktreeWatcher({ onChange: () => {}, watch: fake.watch, resolveGitDir: () => undefined })

    watcher.sync([worktree('a'), worktree('b')])
    expect(fake.open()).toBe(2)

    watcher.sync([worktree('a', { path: '/elsewhere/a' })])
    expect(fake.targets()).toEqual(['/elsewhere/a'])
    expect(watcher.watchedIds).toEqual(['a'])
  })

  it('collapses a burst of changes into one report', () => {
    const clock = createClock()
    const fake = createFakeWatch()
    let reports = 0
    const watcher = new WorktreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      resolveGitDir: () => undefined,
      settleMs: 100,
      minIntervalMs: 0,
      now: clock.now,
      schedule: clock.schedule
    })
    watcher.sync([worktree('a')])

    for (let index = 0; index < 50; index += 1) fake.fire('/checkouts/a', `src/file-${index}.ts`)
    expect(reports).toBe(0)

    clock.advance(100)
    expect(reports).toBe(1)
  })

  it('holds a continuously changing tree to the minimum interval', () => {
    const clock = createClock()
    const fake = createFakeWatch()
    let reports = 0
    const watcher = new WorktreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      resolveGitDir: () => undefined,
      settleMs: 100,
      minIntervalMs: 1_000,
      now: clock.now,
      schedule: clock.schedule
    })
    watcher.sync([worktree('a')])

    fake.fire('/checkouts/a', 'src/a.ts')
    clock.advance(100)
    expect(reports).toBe(1)

    // A second burst right behind the first waits out the interval, not the
    // settle window, so a `npm install` cannot drive a status read per file.
    fake.fire('/checkouts/a', 'src/b.ts')
    clock.advance(100)
    expect(reports).toBe(1)
    clock.advance(900)
    expect(reports).toBe(2)
  })

  it('ignores changes that cannot have moved a status', () => {
    const clock = createClock()
    const fake = createFakeWatch()
    let reports = 0
    const watcher = new WorktreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      resolveGitDir: (checkout) => path.join(checkout, '.git-dir'),
      settleMs: 10,
      minIntervalMs: 0,
      now: clock.now,
      schedule: clock.schedule
    })
    watcher.sync([worktree('a')])

    fake.fire('/checkouts/a', 'node_modules/react/index.js')
    fake.fire(path.join('/checkouts/a', '.git-dir'), 'objects/ab/cdef')
    clock.advance(1_000)
    expect(reports).toBe(0)

    fake.fire(path.join('/checkouts/a', '.git-dir'), 'index')
    clock.advance(10)
    expect(reports).toBe(1)
  })

  it('keeps the git directory covered when the recursive watch is refused', () => {
    const fake = createFakeWatch()
    const degraded: WatchDegraded[] = []
    fake.throwOn((_target, recursive) => recursive && !_target.endsWith('.git-dir'))
    const watcher = new WorktreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      resolveGitDir: (checkout) => path.join(checkout, '.git-dir'),
      onDegraded: (event) => degraded.push(event)
    })

    watcher.sync([worktree('a')])

    expect(watcher.watchedIds).toEqual(['a'])
    expect(watcher.watchesWorkingTree('a')).toBe(false)
    expect(fake.targets()).toEqual([path.join('/checkouts/a', '.git-dir')])
    expect(degraded.map((event) => event.worktreeId)).toEqual(['a'])
  })

  it('records a recursive watch that dies later as degraded, not as gone', () => {
    const fake = createFakeWatch()
    const degraded: WatchDegraded[] = []
    const watcher = new WorktreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      resolveGitDir: () => undefined,
      onDegraded: (event) => degraded.push(event)
    })
    watcher.sync([worktree('a')])
    expect(watcher.watchesWorkingTree('a')).toBe(true)

    fake.fail('/checkouts/a', enospc())

    expect(watcher.watchedIds).toEqual(['a'])
    expect(watcher.watchesWorkingTree('a')).toBe(false)
    expect(watcher.degradedIds).toEqual(['a'])
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.checkoutPath).toBe('/checkouts/a')
  })

  // The old default discarded this, and a status display that has stopped
  // covering edits while still showing numbers is the quietest way to be wrong.
  it('says what a degraded watch costs, in terms somebody could act on', () => {
    const report = degradedWatchReport({ worktreeId: 'a', checkoutPath: '/checkouts/a', error: enospc() })

    expect(report).toContain('/checkouts/a')
    expect(report).toContain('ENOSPC')
    expect(report).toContain('edits will not')
  })

  // A dying inotify watch reports over and over; the app only stops covering
  // edits once.
  it('reports a degradation once however many times the watch complains', () => {
    const fake = createFakeWatch()
    const degraded: WatchDegraded[] = []
    const watcher = new WorktreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      resolveGitDir: () => undefined,
      onDegraded: (event) => degraded.push(event)
    })
    watcher.sync([worktree('a')])

    fake.fail('/checkouts/a', enospc())
    fake.fail('/checkouts/a', enospc())
    fake.fail('/checkouts/a', enospc())

    expect(degraded).toHaveLength(1)
  })

  it('retries next sync when nothing could be watched at all', () => {
    const fake = createFakeWatch()
    fake.throwOn(() => true)
    const watcher = new WorktreeWatcher({
      onChange: () => {},
      watch: fake.watch,
      resolveGitDir: () => undefined,
      onDegraded: () => {}
    })

    watcher.sync([worktree('a')])
    expect(watcher.watchedIds).toEqual([])

    fake.throwOn(() => false)
    watcher.sync([worktree('a')])
    expect(watcher.watchedIds).toEqual(['a'])
  })

  it('drops every watch and any pending report on close', () => {
    const clock = createClock()
    const fake = createFakeWatch()
    let reports = 0
    const watcher = new WorktreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      resolveGitDir: () => undefined,
      settleMs: 100,
      now: clock.now,
      schedule: clock.schedule
    })
    watcher.sync([worktree('a'), worktree('b')])
    fake.fire('/checkouts/a', 'src/a.ts')

    watcher.close()

    expect(fake.open()).toBe(0)
    clock.advance(10_000)
    expect(reports).toBe(0)
    // A sync after close must not quietly bring the watches back.
    watcher.sync([worktree('a')])
    expect(fake.open()).toBe(0)
  })

  it('reports a real file appearing in a real directory', async (ctx) => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-watch-'))
    created.push(checkout)
    await mkdir(path.join(checkout, 'src'), { recursive: true })

    const reported = new Promise<void>((resolve, reject) => {
      const watcher = new WorktreeWatcher({
        onChange: () => {
          watcher.close()
          resolve()
        },
        // This is the only test that asks the kernel for a real watch, and a
        // watch is a scarce per-user resource. Left alone it does not fail —
        // it simply never fires, and the run dies thirty seconds later saying
        // nothing at all, sending the next reader hunting a race that is not
        // there.
        onDegraded: (event) => {
          watcher.close()
          reject(new WatchRefused(event))
        },
        resolveGitDir: () => undefined,
        settleMs: 20,
        minIntervalMs: 0
      })
      watcher.sync([worktree('a', { path: checkout })])
      // Written after the watch is up, or there would be nothing to notice.
      setTimeout(() => void writeFile(path.join(checkout, 'src', 'App.tsx'), 'export {}\n'), 50)
    })

    try {
      await reported
    } catch (error) {
      // A machine with nothing left to give proves nothing about this watcher,
      // so it is said out loud and stepped over rather than reported as a
      // fault in code that was never run.
      if (error instanceof WatchRefused && error.isResourceShortage) ctx.skip(error.message)
      throw error
    }
  })
})

/** Carries the real cause out of the watcher, so the runner can name it. */
class WatchRefused extends Error {
  readonly isResourceShortage: boolean

  constructor(event: WatchDegraded) {
    const code = (event.error as NodeJS.ErrnoException | null)?.code
    super(`${degradedWatchReport(event)}${code === 'EMFILE' || code === 'ENOSPC' ? INOTIFY_HINT : ''}`)
    this.name = 'WatchRefused'
    this.isResourceShortage = code === 'EMFILE' || code === 'ENOSPC'
  }
}

/** Where to look, since the cause is the machine rather than this code. */
const INOTIFY_HINT =
  process.platform === 'linux'
    ? ' Compare /proc/sys/fs/inotify/max_user_instances against what this user already holds; ' +
      'parallel editors, watchers and test runners exhaust it long before a big tree does.'
    : ''

describe('resolveGitDir', () => {
  const created: string[] = []
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('follows the pointer a linked worktree leaves behind', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-gitdir-'))
    created.push(base)
    const checkout = path.join(base, 'checkout')
    const target = path.join(base, 'repo', '.git', 'worktrees', 'login-fix')
    await mkdir(checkout, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(path.join(checkout, '.git'), `gitdir: ${target}\n`)

    expect(resolveGitDir(checkout)).toBe(target)
  })

  it('resolves a relative pointer against the checkout', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-gitdir-'))
    created.push(base)
    const checkout = path.join(base, 'checkout')
    await mkdir(path.join(base, 'repo', '.git', 'worktrees', 'a'), { recursive: true })
    await mkdir(checkout, { recursive: true })
    await writeFile(path.join(checkout, '.git'), 'gitdir: ../repo/.git/worktrees/a\n')

    expect(resolveGitDir(checkout)).toBe(path.join(base, 'repo', '.git', 'worktrees', 'a'))
  })

  it('takes a primary checkout as it finds it', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-gitdir-'))
    created.push(checkout)
    await mkdir(path.join(checkout, '.git'))

    expect(resolveGitDir(checkout)).toBe(path.join(checkout, '.git'))
  })

  it('says nothing rather than guessing when there is no git directory', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-gitdir-'))
    created.push(checkout)

    expect(resolveGitDir(checkout)).toBeUndefined()
    await writeFile(path.join(checkout, '.git'), 'not a pointer\n')
    expect(resolveGitDir(checkout)).toBeUndefined()
  })
})
