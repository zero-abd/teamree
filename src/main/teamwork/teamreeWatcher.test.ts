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
import { degradedTeamreeWatchReport, TeamreeWatcher, type WatchFn, type WatchHandle } from './teamreeWatcher'

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
    refuse: (target, error) => refusals.set(target, error)
  }
}

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
  })

  it('ignores everything in the checkout that is not .teamree', () => {
    const fake = fakeWatches()
    let reports = 0
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      watch: fake.watch,
      schedule: (task) => {
        task()
        return () => {}
      }
    })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    // An agent building in the checkout must not cost a roster read per file.
    fake.fire('/repo', 'dist')
    expect(reports).toBe(0)
    fake.fire('/repo', '.teamree')
    expect(reports).toBe(1)
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
  })

  it('drops the watches of a project that is no longer in the list', () => {
    const fake = fakeWatches()
    const watcher = new TeamreeWatcher({ onChange: () => {}, watch: fake.watch })
    watcher.sync([{ id: 'p1', path: '/repo' }])
    expect(watcher.watchedIds).toEqual(['p1'])
    watcher.sync([])
    expect(watcher.watchedIds).toEqual([])
    expect(watcher.watches('p1')).toBe(false)
  })
})
