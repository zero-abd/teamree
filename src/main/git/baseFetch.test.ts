import { describe, expect, it } from 'vitest'
import type { BaseFetchState } from '../../shared/entities'
import {
  BaseFetcher,
  backgroundFetchProjects,
  classifyFetchFailure,
  ONLINE_POLL_MS,
  RECONNECT_DELAY_MS,
  type BaseFetchProject
} from './baseFetch'
import { GitCommandError } from './errors'
import type { GitOutput, GitRun, GitRunner } from './gitProcess'

/** Answers `git remote`, `rev-parse` and `log`, and hands every fetch to `onFetch`, which may throw. */
function fakeRunner(onFetch: (run: GitRun) => GitOutput): { runner: GitRunner; fetches: GitRun[] } {
  const fetches: GitRun[] = []
  let sha = 1
  const tryRun = async (run: GitRun): Promise<GitOutput> => {
    if (run.args[0] === 'remote') return { exitCode: 0, stdout: 'origin\n', stderr: '' }
    if (run.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${sha}\n`, stderr: '' }
    if (run.args[0] === 'log') return { exitCode: 0, stdout: '', stderr: '' }
    fetches.push(run)
    const output = onFetch(run)
    if (output.exitCode === 0 && output.stdout === 'moved') sha += 1
    return output
  }
  return {
    fetches,
    runner: { binary: 'git', tryRun, run: tryRun }
  }
}

const ok: GitOutput = { exitCode: 0, stdout: '', stderr: '' }
const project: BaseFetchProject = { id: 'p1', path: '/repo', baseRef: 'origin/main' }

function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000
  return { now: () => at, advance: (ms) => (at += ms) }
}

describe('BaseFetcher', () => {
  it('fetches the base branch with no prompt allowed, and reports a moved base', async () => {
    const { runner, fetches } = fakeRunner(() => ({ exitCode: 0, stdout: 'moved', stderr: '' }))
    const moved: string[] = []
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: (id) => moved.push(id) })

    await fetcher.fetchNow()

    expect(fetches).toHaveLength(1)
    expect(fetches[0]?.args).toEqual(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    expect(fetches[0]?.cwd).toBe('/repo')
    expect(fetches[0]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' })
    expect(moved).toEqual(['p1'])
  })

  // The teamwork fetch is a different fetch on the same timer, focus floor and back-off.
  it('runs the fetch it is given instead of its own, and is armed only once started', async () => {
    const { runner, fetches } = fakeRunner(() => ok)
    const asked: string[] = []
    const moved: string[] = []
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      fetch: (target) => (asked.push(target.id), Promise.resolve('moved')),
      onMoved: (id) => moved.push(id),
      schedule: () => () => {}
    })
    expect(fetcher.armed).toBe(false)

    await fetcher.fetchNow()
    fetcher.start()

    expect(fetches).toEqual([])
    expect(asked).toEqual(['p1'])
    expect(moved).toEqual(['p1'])
    expect(fetcher.armed).toBe(true)
    fetcher.stop()
    expect(fetcher.armed).toBe(false)
  })

  it('says nothing when the base did not move', async () => {
    const { runner } = fakeRunner(() => ok)
    const moved: string[] = []
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: (id) => moved.push(id) })
    await fetcher.fetchNow()
    expect(moved).toEqual([])
  })

  it('does not ask again on every focus', async () => {
    const time = clock()
    const { runner, fetches } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: () => {}, now: time.now })

    await fetcher.nudge()
    time.advance(10_000)
    await fetcher.nudge()
    expect(fetches).toHaveLength(1)

    time.advance(60_000)
    await fetcher.nudge()
    expect(fetches).toHaveLength(2)
  })

  it('backs off a project after a sign-in failure instead of retrying every cycle', async () => {
    const time = clock()
    const { runner, fetches } = fakeRunner(() => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled"
    }))
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: () => {}, now: time.now })

    await fetcher.fetchNow()
    for (let cycle = 0; cycle < 5; cycle += 1) {
      time.advance(5 * 60_000)
      await fetcher.fetchNow()
    }
    expect(fetches).toHaveLength(1)

    time.advance(60 * 60_000)
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(2)
  })

  // A credential helper waiting on a dialog nobody answers holds git open; the runner kills it at the limit.
  it('gives every fetch a hard limit, and backs off after one that hit it as after a refused sign-in', async () => {
    const time = clock()
    const { runner, fetches } = fakeRunner((run) => {
      throw new GitCommandError({ args: run.args, cwd: run.cwd, exitCode: null, stderr: '', timedOut: true })
    })
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: () => {}, now: time.now })

    await fetcher.fetchNow()
    expect(fetches[0]?.timeoutMs).toBe(60_000)
    time.advance(10 * 60_000)
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(1)
  })

  it('fetches nothing while offline', async () => {
    const { runner, fetches } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: () => {}, online: () => false })
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(0)
  })

  it('skips a base with no remote in front of it', async () => {
    const { runner, fetches } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [{ ...project, baseRef: 'main' }],
      onMoved: () => {}
    })
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(0)
  })

  it('fetches on a timer once started, and not after stop', async () => {
    const timers: (() => void)[] = []
    const { runner, fetches } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      schedule: (run) => {
        timers.push(run)
        return () => {}
      }
    })
    fetcher.start()
    expect(timers).toHaveLength(1)
    timers[0]?.()
    await fetcher.idle()
    expect(fetches).toHaveLength(1)

    fetcher.stop()
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(1)
  })

  it('reads the interval for each wait, and moves the wait under way when it changes', () => {
    const timers: { run: () => void; delayMs: number }[] = []
    let minutes = 5
    const { runner } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      intervalMs: () => minutes * 60_000,
      schedule: (run, delayMs) => {
        const timer = { run, delayMs }
        timers.push(timer)
        return () => timers.splice(timers.indexOf(timer), 1)
      }
    })
    fetcher.start()
    timers.shift()?.run()
    expect(timers.map((timer) => timer.delayMs)).toEqual([5 * 60_000])

    fetcher.reschedule()
    expect(timers.map((timer) => timer.delayMs)).toEqual([5 * 60_000])

    minutes = 30
    fetcher.reschedule()
    expect(timers.map((timer) => timer.delayMs)).toEqual([30 * 60_000])
    fetcher.stop()
  })
})

describe('BaseFetcher state', () => {
  function failing(stderr: string): GitOutput {
    return { exitCode: 128, stdout: '', stderr }
  }

  it('keeps the last success and names each kind of failure', async () => {
    const time = clock()
    let next: GitOutput = ok
    const { runner } = fakeRunner(() => next)
    const states: BaseFetchState[] = []
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      onState: (id, state) => id === 'p1' && states.push(state),
      now: time.now
    })

    await fetcher.fetchNow()
    expect(states.at(-1)).toEqual({ fetchedAt: 1_000_000 })

    const kinds: [string, BaseFetchState['failure']][] = [
      ["fatal: unable to access 'https://x/': Could not resolve host: x", 'offline'],
      ["fatal: couldn't find remote ref main", 'not-found'],
      ['fatal: something else', 'failed'],
      ['fatal: Authentication failed for https://x', 'auth']
    ]
    for (const [stderr, failure] of kinds) {
      next = failing(stderr)
      time.advance(10 * 60_000)
      await fetcher.fetchProject(project)
      expect(states.at(-1)).toMatchObject({ fetchedAt: 1_000_000, failure })
    }
    expect(states.at(-1)?.retryAt).toBe(time.now() + 30 * 60_000)
  })

  it('says offline without trying while the machine has no network', async () => {
    const { runner, fetches } = fakeRunner(() => ok)
    const states: BaseFetchState[] = []
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      onState: (_id, state) => states.push(state),
      online: () => false,
      lastFetchedAt: () => Promise.resolve(42)
    })
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(0)
    expect(states).toEqual([{ fetchedAt: 42, failure: 'offline' }])
  })

  it('Fetch Now tries at once through a sign-in back-off, and clears it on success', async () => {
    const time = clock()
    let next: GitOutput = failing('fatal: Authentication failed for https://x')
    const { runner, fetches } = fakeRunner(() => next)
    const states: BaseFetchState[] = []
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      onState: (_id, state) => states.push(state),
      now: time.now
    })

    await fetcher.fetchNow()
    expect(states.at(-1)?.retryAt).toBeDefined()
    time.advance(60_000)
    next = ok
    expect(await fetcher.fetchProject(project)).toEqual({ fetchedAt: time.now() })
    expect(fetches).toHaveLength(2)

    // The back-off is gone: the next timed cycle fetches.
    time.advance(5 * 60_000)
    await fetcher.fetchNow()
    expect(fetches).toHaveLength(3)
  })

  it('never backs off a refused sign-in for more than an hour', async () => {
    const time = clock()
    const { runner, fetches } = fakeRunner(() => failing('fatal: Authentication failed for https://x'))
    const fetcher = new BaseFetcher({ runner, projects: () => [project], onMoved: () => {}, now: time.now })
    for (let hour = 0; hour < 6; hour += 1) {
      await fetcher.fetchNow()
      time.advance(60 * 60_000)
    }
    expect(fetches).toHaveLength(6)
  })

  it('fetches soon after the network comes back', async () => {
    const timers: { run: () => void; delayMs: number }[] = []
    let online = false
    const { runner, fetches } = fakeRunner(() => ok)
    const fetcher = new BaseFetcher({
      runner,
      projects: () => [project],
      onMoved: () => {},
      online: () => online,
      schedule: (run, delayMs) => {
        const timer = { run, delayMs }
        timers.push(timer)
        return () => timers.splice(timers.indexOf(timer), 1)
      }
    })
    fetcher.start()
    const fire = (delayMs: number): void => {
      const timer = timers.find((each) => each.delayMs === delayMs)
      expect(timer).toBeDefined()
      timers.splice(timers.indexOf(timer!), 1)
      timer!.run()
    }

    fire(ONLINE_POLL_MS)
    await fetcher.idle()
    expect(fetches).toHaveLength(0)

    online = true
    fire(ONLINE_POLL_MS)
    fire(RECONNECT_DELAY_MS)
    await fetcher.idle()
    expect(fetches).toHaveLength(1)
    fetcher.stop()
  })
})

describe('backgroundFetchProjects', () => {
  it('takes projects with a ready worktree, leaving out any with background fetching turned off', () => {
    const worktree = (id: string, projectId: string, state: 'ready' | 'creating') =>
      ({ id, projectId, state }) as Parameters<typeof backgroundFetchProjects>[0]['worktrees'][number]
    const picked = backgroundFetchProjects({
      projects: [
        { id: 'a', name: 'a', path: '/a', baseRef: 'origin/main' },
        { id: 'b', name: 'b', path: '/b', baseRef: 'origin/main', fetchInBackground: false },
        { id: 'c', name: 'c', path: '/c', baseRef: 'origin/main' }
      ],
      worktrees: [worktree('w1', 'a', 'ready'), worktree('w2', 'b', 'ready'), worktree('w3', 'c', 'creating')]
    })
    expect(picked).toEqual([{ id: 'a', path: '/a', baseRef: 'origin/main' }])
  })
})

describe('classifyFetchFailure', () => {
  it('tells a refused sign-in from a machine that is offline', () => {
    expect(classifyFetchFailure('fatal: Authentication failed for https://x')).toBe('auth')
    expect(classifyFetchFailure('git@x: Permission denied (publickey).')).toBe('auth')
    expect(classifyFetchFailure('Host key verification failed.')).toBe('auth')
    expect(classifyFetchFailure("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe('offline')
    expect(classifyFetchFailure('fatal: something else')).toBe('failed')
  })

  it('tells a missing branch or repository from a refused sign-in', () => {
    expect(classifyFetchFailure("fatal: couldn't find remote ref main")).toBe('not-found')
    expect(
      classifyFetchFailure(
        "fatal: '/tmp/gone.git' does not appear to be a git repository\nfatal: Could not read from remote repository."
      )
    ).toBe('not-found')
  })
})
