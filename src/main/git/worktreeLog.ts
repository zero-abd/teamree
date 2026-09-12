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
  // remote — and is not worth an error. The honest answer is that nothing is
  // known, which an empty list already says.
  if (result.exitCode !== 0) return { ...base, commits: [], truncated: false }

  const all = parseLogRecords(result.stdout)
  return { ...base, commits: all.slice(0, limit), truncated: all.length > limit }
}
