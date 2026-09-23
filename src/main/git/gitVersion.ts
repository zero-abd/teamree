// Compatibility floor: git 2.25 covers everything this service runs. Newer and
// avoided: `worktree list --porcelain -z` (2.36), `worktree add --orphan`
// (2.42), `rev-parse --path-format` (2.31). Probed once per runner and cached.

import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

export type GitVersion = { major: number; minor: number; patch: number; raw: string }

export const MINIMUM_GIT_VERSION: GitVersion = { major: 2, minor: 25, patch: 0, raw: '2.25.0' }

/** `git version 2.39.3 (Apple Git-145)` and friends. */
export function parseGitVersion(raw: string): GitVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: raw.trim()
  }
}

export function isAtLeast(version: GitVersion, floor: { major: number; minor: number; patch?: number }): boolean {
  if (version.major !== floor.major) return version.major > floor.major
  if (version.minor !== floor.minor) return version.minor > floor.minor
  return version.patch >= (floor.patch ?? 0)
}

export function createVersionProbe(runner: GitRunner): (cwd: string) => Promise<GitVersion> {
  let cached: Promise<GitVersion> | undefined
  return (cwd: string) => {
    cached ??= (async () => {
      const { stdout } = await runner.run({ args: ['--version'], cwd, readOnly: true, timeoutMs: 15_000 })
      const version = parseGitVersion(stdout)
      if (!version) {
        throw new GitServiceError(ErrorCode.GitFailed, `could not read a version from "${stdout.trim()}"`)
      }
      if (!isAtLeast(version, MINIMUM_GIT_VERSION)) {
        throw new GitServiceError(
          ErrorCode.GitFailed,
          `git ${version.raw} is too old; teamree needs ${MINIMUM_GIT_VERSION.raw} or newer`
        )
      }
      return version
    })().catch((error: unknown) => {
      cached = undefined // a transient probe failure must not poison the process
      throw error
    })
    return cached
  }
}
