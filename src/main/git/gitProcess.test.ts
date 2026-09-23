import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitCommandError } from './errors'
import { createGitRunner } from './gitProcess'
import { isAtLeast, MINIMUM_GIT_VERSION, parseGitVersion } from './gitVersion'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  return repo
}

describe('git runner', () => {
  it('captures stdout and stderr separately and surfaces git stderr on failure', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()

    const ok = await runner.run({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: repo.repoPath })
    expect(ok.stdout.trim()).toBe('main')
    expect(ok.stderr).toBe('')

    const failure = await runner.run({ args: ['checkout', 'no-such-ref'], cwd: repo.repoPath }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(GitCommandError)
    const error = failure as GitCommandError
    expect(error.exitCode).not.toBe(0)
    expect(error.stderr).toContain('no-such-ref')
    expect(error.message).toContain('no-such-ref')
  })

  it('reports a non-zero exit without throwing when the caller expects failure', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()

    const result = await runner.tryRun({ args: ['rev-parse', '--verify', '--quiet', 'nope'], cwd: repo.repoPath })

    expect(result.exitCode).toBe(1)
    expect(result.stdout.trim()).toBe('')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()

    const error = (await runner
      .run({ args: ['status'], cwd: repo.repoPath, signal: AbortSignal.abort() })
      .catch((e: unknown) => e)) as GitCommandError

    expect(error).toBeInstanceOf(GitCommandError)
    expect(error.cancelled).toBe(true)
  })

  it('kills a command that outruns its timeout', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()

    // `hash-object --stdin` never finishes on its own; a fast command with a
    // 1ms timeout would race under load.
    const error = (await runner
      .run({ args: ['hash-object', '--stdin'], cwd: repo.repoPath, timeoutMs: 250 })
      .catch((e: unknown) => e)) as GitCommandError

    expect(error).toBeInstanceOf(GitCommandError)
    expect(error.timedOut).toBe(true)
    expect(error.message).toContain('timed out')
  })

  // Decisions are made by matching git's English prose; without this pin a
  // German machine reads "Alles aktuell" and reports a push that sent nothing as work.
  it('hands git a locale that keeps its messages untranslated', async () => {
    if (process.platform === 'win32') return
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-locale-'))
    const reporter = path.join(base, 'report-locale')
    await writeFile(reporter, '#!/bin/sh\necho "LC_ALL=$LC_ALL LANGUAGE=$LANGUAGE"\n', 'utf8')
    await chmod(reporter, 0o755)

    const { stdout } = await createGitRunner(reporter).run({
      args: ['status'],
      cwd: base,
      // The ambient environment of somebody who does not work in English.
      env: { LANG: 'de_DE.UTF-8' }
    })

    expect(stdout.trim()).toBe('LC_ALL=C LANGUAGE=')
    await rm(base, { recursive: true, force: true })
  })

  // A caller that wanted the first megabyte must not be handed a failure for forty.
  it('clips stdout to the caller’s budget instead of failing on a huge read', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()
    await repo.write('big.txt', `${'x'.repeat(79)}\n`.repeat(200_000))
    await repo.commit('a large file')

    const result = await runner.run({
      args: ['show', 'HEAD:big.txt'],
      cwd: repo.repoPath,
      stdoutLimitBytes: 64 * 1024
    })

    expect(result.stdoutClipped).toBe(true)
    expect(result.stdout.length).toBeGreaterThanOrEqual(64 * 1024)
    expect(result.stdout.length).toBeLessThan(16 * 1024 * 1024)
  })

  it('leaves an output that fits unclipped', async () => {
    const repo = await newRepo()
    const runner = createGitRunner()

    const result = await runner.run({
      args: ['rev-parse', 'HEAD'],
      cwd: repo.repoPath,
      stdoutLimitBytes: 64 * 1024
    })

    expect(result.stdoutClipped).toBeUndefined()
    expect(result.stdout.trim()).toHaveLength(40)
  })

  it('explains a missing git binary instead of leaking ENOENT', async () => {
    const repo = await newRepo()
    const runner = createGitRunner('teamree-definitely-not-git')

    const error = (await runner
      .run({ args: ['status'], cwd: repo.repoPath })
      .catch((e: unknown) => e)) as GitCommandError

    expect(error.stderr).toContain('git executable not found')
  })
})

describe('version floor', () => {
  it('parses the shapes git --version prints', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)')).toMatchObject({ major: 2, minor: 39, patch: 3 })
    expect(parseGitVersion('git version 2.25.1')).toMatchObject({ major: 2, minor: 25, patch: 1 })
    expect(parseGitVersion('git version 2.45.windows.1')).toMatchObject({ major: 2, minor: 45, patch: 0 })
    expect(parseGitVersion('not a version')).toBeNull()
  })

  it('compares against the supported floor', () => {
    expect(isAtLeast({ major: 2, minor: 25, patch: 0, raw: '' }, MINIMUM_GIT_VERSION)).toBe(true)
    expect(isAtLeast({ major: 2, minor: 24, patch: 9, raw: '' }, MINIMUM_GIT_VERSION)).toBe(false)
    expect(isAtLeast({ major: 3, minor: 0, patch: 0, raw: '' }, MINIMUM_GIT_VERSION)).toBe(true)
  })

  it('is what the installed git satisfies', async () => {
    const runner = createGitRunner()
    const { stdout } = await runner.run({ args: ['--version'], cwd: process.cwd() })
    const version = parseGitVersion(stdout)
    expect(version).not.toBeNull()
    expect(isAtLeast(version!, MINIMUM_GIT_VERSION)).toBe(true)
  })
})
