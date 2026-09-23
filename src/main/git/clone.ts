// `git clone` for the app and the CLI: no shell, the user's own credential
// helper, `GIT_TERMINAL_PROMPT=0` (gitProcess) and ssh in batch mode, so a
// missing credential fails with one line instead of waiting on a prompt.

import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CLONE_PARENT, repositoryNameFromUrl } from '../../shared/cloneDestination'
import { ErrorCode } from '../../shared/protocol'
import { sshCommand, splitProgress } from '../teamwork/publish'
import { GitCommandError, GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { pushFailureKind } from './worktreePush'

/** Long enough for a large repository on a slow link; a clone can be cancelled well before. */
export const CLONE_TIMEOUT_MS = 30 * 60_000

export type CloneFailure = 'auth' | 'host-key' | 'not-found' | 'exists' | 'timeout' | 'cancelled' | 'other'

export type CloneResult = { ok: true } | { ok: false; kind: CloneFailure; stderr: string }

export type CloneRun = {
  origin: string
  /** Absolute; git makes the missing parents itself. */
  into: string
  /** An existing directory; only the config git reads depends on it. */
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

/** Runs the clone and classifies how it ended. Rejects only when git never started. */
export async function runClone(runner: GitRunner, run: CloneRun): Promise<CloneResult> {
  const ssh = await sshCommand(runner, run.cwd)
  try {
    const result = await runner.tryRun({
      // `--` first: a URL must never be read as an option.
      args: ['clone', '--progress', '--', run.origin, run.into],
      cwd: run.cwd,
      timeoutMs: run.timeoutMs ?? CLONE_TIMEOUT_MS,
      env: { GIT_SSH_COMMAND: ssh },
      ...(run.signal ? { signal: run.signal } : {}),
      onStderr: (chunk) => {
        if (run.onProgress) for (const line of splitProgress(chunk)) run.onProgress(line)
      }
    })
    if (result.exitCode === 0) return { ok: true }
    return { ok: false, kind: cloneFailureKind(result.stderr), stderr: result.stderr }
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error
    if (error.cancelled) return { ok: false, kind: 'cancelled', stderr: error.stderr }
    if (error.timedOut) return { ok: false, kind: 'timeout', stderr: error.stderr }
    throw error
  }
}

const NOT_FOUND =
  /repository not found|repository '.*' (?:not found|does not exist)|does not appear to be a git repository|not a git repository/i

export function cloneFailureKind(stderr: string): CloneFailure {
  if (/already exists and is not an empty directory/i.test(stderr)) return 'exists'
  // Before the push classifier, which reads "repository not found" as auth.
  if (NOT_FOUND.test(stderr)) return 'not-found'
  const kind = pushFailureKind(stderr)
  return kind === 'auth' || kind === 'host-key' ? kind : 'other'
}

export function cloneFailureLine(kind: CloneFailure, stderr: string): string {
  switch (kind) {
    case 'auth':
      return 'Authentication failed'
    case 'host-key':
      return 'Unknown ssh host key'
    case 'not-found':
      return 'Repository not found'
    case 'exists':
      return 'Destination exists'
    case 'timeout':
      return 'Clone timed out'
    case 'cancelled':
      return 'Clone cancelled'
    case 'other': {
      const lines = stderr
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean)
      const fatal = lines.find((line) => /^(?:fatal|error):/.test(line)) ?? lines.at(-1) ?? ''
      return fatal.replace(/^(?:fatal|error):\s*/, '') || 'Clone failed'
    }
  }
}

export function cloneFailureCode(kind: CloneFailure): ErrorCode {
  if (kind === 'exists') return ErrorCode.Conflict
  if (kind === 'not-found') return ErrorCode.NotFound
  return ErrorCode.GitFailed
}

/** `given` expanded when it starts with `~`; `~/code/<repo>` when absent. */
export function cloneDestination(url: string, given: string | undefined, home = os.homedir()): string {
  let target = given?.trim() || `${DEFAULT_CLONE_PARENT}/${repositoryNameFromUrl(url)}`
  if (target === '~' || target.startsWith('~/')) target = path.join(home, target.slice(1))
  if (!path.isAbsolute(target)) {
    throw new GitServiceError(ErrorCode.InvalidParams, `destination must be absolute, got "${target}"`)
  }
  if (!given && !repositoryNameFromUrl(url)) {
    throw new GitServiceError(ErrorCode.InvalidParams, 'name a destination for this URL')
  }
  return path.resolve(target)
}
