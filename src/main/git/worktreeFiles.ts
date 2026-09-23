// What is in a worktree's directories, one directory per call, names and kinds
// only, and which of it git ignores. `git check-ignore` decides "ignored", fed
// every name on stdin, rather than a second reading of `.gitignore` here.

import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WorktreeFileEntry, WorktreeFileMatches, WorktreeFiles } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

/** Entries returned before a listing reports itself truncated. */
export const DEFAULT_FILES_LIMIT = 2_000

/** Matches returned before a search reports itself truncated. */
export const DEFAULT_FIND_LIMIT = 200

/** The bytes of `git ls-files` a search reads before it stops, so one keystroke cannot hold a runtime's memory. */
const FIND_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024

export type FilesReadOptions = {
  worktreeId: string
  worktreePath: string
  /** Relative to the worktree root. Absent or empty is the root itself. */
  path?: string
  limit?: number
  signal?: AbortSignal
  now?: () => number
}

/**
 * The directory `relative` names inside `worktreePath`, or null. Resolved
 * lexically: `..` is refused by what it spells. Forward slashes because git is asked about it later.
 */
export function resolveInsideWorktree(
  worktreePath: string,
  relative: string | undefined
): { absolute: string; relative: string } | null {
  const asked = relative ?? ''
  if (path.isAbsolute(asked) || path.posix.isAbsolute(asked)) return null
  const root = path.resolve(worktreePath)
  const absolute = path.resolve(root, asked)
  if (absolute === root) return { absolute, relative: '' }
  const inside = path.relative(root, absolute)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return { absolute, relative: inside.split(path.sep).join('/') }
}

export async function readWorktreeFiles(runner: GitRunner, options: FilesReadOptions): Promise<WorktreeFiles> {
  const limit = options.limit ?? DEFAULT_FILES_LIMIT
  const target = resolveInsideWorktree(options.worktreePath, options.path)
  if (target === null) {
    throw new GitServiceError(ErrorCode.InvalidParams, `"${options.path ?? ''}" is not a directory inside the worktree`)
  }

  let names: string[]
  try {
    names = await readdir(target.absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new GitServiceError(ErrorCode.NotFound, `no directory at "${target.relative}" in the worktree`)
    }
    throw new GitServiceError(ErrorCode.Internal, `could not read "${target.relative}": ${String(error)}`)
  }

  // A linked worktree has a `.git` file rather than a directory; either way it is not the tree.
  const listed = names.filter((name) => name !== '.git')

  const kinds = await Promise.all(
    listed.map(async (name) => {
      try {
        const stat = await lstat(path.join(target.absolute, name))
        return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'
      } catch {
        // Gone between the readdir and the stat; called a file rather than
        // dropped, so the listing and the count agree.
        return 'file' as const
      }
    })
  )

  const relativeOf = (name: string): string => (target.relative === '' ? name : `${target.relative}/${name}`)
  const ignored = await ignoredPaths(runner, options.worktreePath, listed.map(relativeOf), options.signal)

  const entries: WorktreeFileEntry[] = listed.map((name, index) => ({
    name,
    kind: kinds[index] ?? 'file',
    ignored: ignored.has(relativeOf(name))
  }))
  entries.sort(byKindThenName)

  return {
    worktreeId: options.worktreeId,
    path: target.relative,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    readAt: (options.now ?? Date.now)()
  }
}

/** Directories first, then everything else, each half in name order. */
function byKindThenName(left: WorktreeFileEntry, right: WorktreeFileEntry): number {
  const rank = (entry: WorktreeFileEntry): number => (entry.kind === 'dir' ? 0 : 1)
  return rank(left) - rank(right) || byName(left.name, right.name)
}

/** The case-blind order a file manager uses; a tie is broken by the bytes. */
function byName(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
}

/**
 * Which of these paths git ignores, asked once for the lot. `check-ignore` exits
 * 1 when none is ignored, so `tryRun`; anything else is treated as nothing ignored.
 */
async function ignoredPaths(
  runner: GitRunner,
  worktreePath: string,
  relativePaths: readonly string[],
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  if (relativePaths.length === 0) return new Set()
  const answer = await runner.tryRun({
    // `--no-index` is deliberately absent: git does not call a tracked path ignored.
    args: ['check-ignore', '-z', '--stdin'],
    cwd: worktreePath,
    readOnly: true,
    stdin: relativePaths.map((entry) => `${entry}\0`).join(''),
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  if (answer.exitCode > 1) return new Set()
  return new Set(answer.stdout.split('\0').filter((entry) => entry.length > 0))
}

export type FindOptions = {
  worktreeId: string
  worktreePath: string
  query: string
  limit?: number
  signal?: AbortSignal
  now?: () => number
}

/**
 * Every path git tracks or would track whose relative path contains `query`,
 * so `util/str` finds `src/util/strings.ts`.
 */
export async function findWorktreeFiles(runner: GitRunner, options: FindOptions): Promise<WorktreeFileMatches> {
  const limit = options.limit ?? DEFAULT_FIND_LIMIT
  const query = options.query.trim().toLowerCase()
  const readAt = (options.now ?? Date.now)()
  if (query === '') return { worktreeId: options.worktreeId, query: options.query, paths: [], truncated: false, readAt }

  const { stdout, stdoutClipped } = await runner.run({
    args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    cwd: options.worktreePath,
    readOnly: true,
    stdoutLimitBytes: FIND_STDOUT_LIMIT_BYTES,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 60_000
  })

  const paths: string[] = []
  let truncated = stdoutClipped === true
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0 || !entry.toLowerCase().includes(query)) continue
    if (paths.length === limit) {
      truncated = true
      break
    }
    paths.push(entry)
  }

  // Path order rather than git's, which lists the index before the untracked files.
  paths.sort(byName)
  return { worktreeId: options.worktreeId, query: options.query, paths, truncated, readAt }
}
