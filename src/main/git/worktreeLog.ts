// The commits a worktree has made that its base does not have. Scoped to
// `base..branch` because the question is "what did this worktree do".

import type { WorktreeLog } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { assertRefShape, comparesAgainstItself } from './repository'

/** Commits returned before the list reports itself capped. */
export const DEFAULT_LOG_LIMIT = 50

/**
 * NUL separates fields, the one byte a subject cannot contain. Spelt `%x00` in
 * the format string because an argv entry is itself NUL-terminated.
 */
const FIELD_FORMAT = '%x00'
const FIELD = '\0'

/** Reads `log`'s NUL-separated fields; every field including the last is terminated. */
export function parseLogRecords(raw: string): WorktreeLog['commits'] {
  const fields = raw.split(FIELD)
  const commits: WorktreeLog['commits'] = []

  // Four fields per commit; a partial record is a truncated read and is dropped.
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = (fields[index] as string).trim()
    if (sha.length === 0) continue
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      author: fields[index + 1] as string,
      // ISO 8601 as git wrote it: it carries the commit's own UTC offset.
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

  // The range would be the branch against itself, which git answers with a
  // clean exit and no commits rather than an error.
  if (comparesAgainstItself(options.baseRef)) {
    return nothingKnown('this project has no base ref to compare against, so nothing here can be called new')
  }

  // A `base..branch` token beginning with a dash is read by git as an option,
  // and `git log --output=<path>` writes a file. A base ref is discovered from
  // the remote's HEAD, which somebody else controls, so it is checked here.
  for (const [ref, label] of [
    [options.baseRef, 'base ref'],
    [options.branch, 'branch']
  ] as const) {
    try {
      assertRefShape(ref, label)
    } catch {
      return nothingKnown(`${label} "${ref}" is not a usable git ref, so nothing here can be compared against it`)
    }
  }

  // One more than asked for, so "there are others" is known without counting.
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

  // An unresolvable base is ordinary (unfetched clone, offline) and not worth an
  // error, but an empty list would read as "committed nothing".
  if (result.exitCode !== 0) return nothingKnown(await refusalReason(runner, options, result.stderr))

  const all = parseLogRecords(result.stdout)
  return { ...base, commits: all.slice(0, limit), truncated: all.length > limit }
}

/** Why git would not walk the range. Asked only once it has refused. */
async function refusalReason(runner: GitRunner, options: LogReadOptions, stderr: string): Promise<string> {
  const resolved = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${options.baseRef}^{commit}`],
    cwd: options.worktreePath,
    readOnly: true,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (resolved.exitCode !== 0) {
    // The same sentence the merge preview gives for the same cause.
    return `base ref "${options.baseRef}" does not resolve; fetch the remote or set another base`
  }
  return firstLine(stderr) || `git could not list what ${options.branch} has that ${options.baseRef} does not`
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}
