// Errors this service raises. They extend RuntimeError because the dispatcher
// recognizes only that type; anything else reaches the wire as `internal`.

import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'

export class GitServiceError extends RuntimeError {
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(code, message, data)
    this.name = 'GitServiceError'
  }
}

/** A git invocation that exited non-zero, timed out, or was cancelled. */
export class GitCommandError extends GitServiceError {
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly stderr: string
  readonly timedOut: boolean
  readonly cancelled: boolean

  constructor(input: {
    args: readonly string[]
    cwd: string
    exitCode: number | null
    stderr: string
    timedOut?: boolean
    cancelled?: boolean
  }) {
    // git's own stderr is the only diagnosis a user can act on, so it leads.
    const detail = firstMeaningfulLine(input.stderr)
    const reason = input.cancelled
      ? 'cancelled'
      : input.timedOut
        ? 'timed out'
        : `exited with code ${input.exitCode ?? 'unknown'}`
    super(
      ErrorCode.GitFailed,
      detail ? `git ${input.args.join(' ')} ${reason}: ${detail}` : `git ${input.args.join(' ')} ${reason}`
    )
    this.name = 'GitCommandError'
    this.args = input.args
    this.cwd = input.cwd
    this.exitCode = input.exitCode
    this.stderr = input.stderr
    this.timedOut = input.timedOut ?? false
    this.cancelled = input.cancelled ?? false
  }
}

function firstMeaningfulLine(stderr: string): string {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** Human-readable reason for any thrown value, for `Worktree.error`. */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}
