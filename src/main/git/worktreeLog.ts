// The commits a worktree has made that its base does not have.
//
// The gap this fills: an agent that finishes its work commits it, and at that
// moment every other view in the app goes quiet. The changes panel empties, the
// status chips drop to zero, and a worktree that has just produced a day's work
// looks exactly like one where nothing happened. The only hint left is a count
// on a badge.
//
// Scoped to `base..branch` rather than to the branch's whole history, because
// the question is never "what is in this repository" — it is "what did this
// worktree do", and everything before the fork belongs to everyone.

import type { WorktreeLog } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { comparesAgainstItself } from './repository'

/** Commits returned before the list reports itself capped. */
export const DEFAULT_LOG_LIMIT = 50

/**
 * The field separator, in the two spellings it needs.
 *
 * A commit subject can hold anything a person can type, newlines included, so
 * fields are separated by NUL — the one byte a message cannot contain. It has
 * to be written as `%x00` in the format string rather than as a literal,
 * because an argv entry is itself NUL-terminated and could never carry one.
 */
const FIELD_FORMAT = '%x00'
const FIELD = '\0'

/**
 * Reads `log`'s NUL-separated fields.
 *
 * The format puts a separator after every field including the last, so each
 * record ends with an empty trailing field and the reader counts fields rather
 * than splitting on lines — which is the whole point, since a subject may
 * contain them.
 */
export function parseLogRecords(raw: string): WorktreeLog['commits'] {
  const fields = raw.split(FIELD)
  const commits: WorktreeLog['commits'] = []

  // Four fields per commit; anything short of a whole record is a truncated
  // read and is dropped rather than half-reported.
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = (fields[index] as string).trim()
    if (sha.length === 0) continue
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      author: fields[index + 1] as string,
      // ISO 8601 as git wrote it, kept as a string: it carries the commit's own
      // UTC offset, which a millisecond number would throw away.
      committedAt: fields[index + 2] as string,
      subject: fields[index + 3] as string
    })
  }
  return commits
}

export type LogReadOptions = {
  worktreeId: string
  /** Read from the worktree, so `branch` resolves against its own HEAD. */
  worktreePath: string
  baseRef: string
  branch: string
  limit?: number
  signal?: AbortSignal
  now?: () => number
}

export async function readWorktreeLog(runner: GitRunner, options: LogReadOptions): Promise<WorktreeLog> {
  const limit = options.limit ?? DEFAULT_LOG_LIMIT
  const base = {
    worktreeId: options.worktreeId,
    baseRef: options.baseRef,
    readAt: (options.now ?? Date.now)()
  }
  const nothingKnown = (unavailable: string): WorktreeLog => ({
    ...base,
    commits: [],
    truncated: false,
    unavailable
  })

  // Read inside the worktree, where HEAD is the branch being asked about: the
  // range would be the branch against itself, and git answers that with a
  // clean exit and no commits rather than with an error.
  if (comparesAgainstItself(options.baseRef)) {
    return nothingKnown('this project has no base ref to compare against, so nothing here can be called new')
  }

  // One more than asked for, so "there are others" is known without walking the
  // whole history to count them.
  const result = await runner.tryRun({
    args: [
      'log',
      `--max-count=${limit + 1}`,
      `--format=%H${FIELD_FORMAT}%an${FIELD_FORMAT}%aI${FIELD_FORMAT}%s${FIELD_FORMAT}`,
      `${options.baseRef}..${options.branch}`
    ],
    cwd: options.worktreePath,
    readOnly: true,
    timeoutMs: 30_000,
    ...(options.signal ? { signal: options.signal } : {})
  })

  // A base ref that does not resolve is the ordinary case here — an unfetched
  // clone, offline, a base deleted on the remote — and is not worth an error.
  // It is emphatically worth saying, though: an empty list reads as "this
  // worktree has committed nothing", which for an agent that has just finished
  // a day's work is the opposite of what happened.
  if (result.exitCode !== 0) return nothingKnown(await refusalReason(runner, options, result.stderr))

  const all = parseLogRecords(result.stdout)
  return { ...base, commits: all.slice(0, limit), truncated: all.length > limit }
}

/**
 * Why git would not walk the range. Asked only once it has refused, so the
 * ordinary read still costs one process.
 */
async function refusalReason(runner: GitRunner, options: LogReadOptions, stderr: string): Promise<string> {
  const resolved = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${options.baseRef}^{commit}`],
    cwd: options.worktreePath,
    readOnly: true,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (resolved.exitCode !== 0) {
    // The same sentence the merge preview gives for the same cause, because it
    // is the same cause and the same thing to do about it.
    return `base ref "${options.baseRef}" does not resolve; fetch the remote or set another base`
  }
  return firstLine(stderr) || `git could not list what ${options.branch} has that ${options.baseRef} does not`
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}
