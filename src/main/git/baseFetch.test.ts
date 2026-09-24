import { describe, expect, it } from 'vitest'
import { BaseFetcher, classifyFetchFailure, type BaseFetchProject } from './baseFetch'
import type { GitOutput, GitRun, GitRunner } from './gitProcess'

/** Answers `git remote` and `rev-parse`, and hands every fetch to `onFetch`. */
function fakeRunner(onFetch: (run: GitRun) => GitOutput): { runner: GitRunner; fetches: GitRun[] } {
  const fetches: GitRun[] = []
  let sha = 1
  const tryRun = async (run: GitRun): Promise<GitOutput> => {
    if (run.args[0] === 'remote') return { exitCode: 0, stdout: 'origin\n', stderr: '' }
    if (run.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${sha}\n`, stderr: '' }
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
})

describe('classifyFetchFailure', () => {
  it('tells a refused sign-in from a machine that is offline', () => {
    expect(classifyFetchFailure('fatal: Authentication failed for https://x')).toBe('auth')
    expect(classifyFetchFailure('git@x: Permission denied (publickey).')).toBe('auth')
    expect(classifyFetchFailure('Host key verification failed.')).toBe('auth')
    expect(classifyFetchFailure("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe('offline')
    expect(classifyFetchFailure('fatal: something else')).toBe('failed')
  })
})
