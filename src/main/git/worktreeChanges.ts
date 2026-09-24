// What actually changed in a worktree, rather than how much: the same
// `git status --porcelain=v2` as the counters, keeping the paths. `-z` is not an
// optimisation: without it git C-quotes paths with spaces, quotes or non-ASCII bytes.

import type { WorktreeChange, WorktreeChangeKind, WorktreeChanges, WorktreeDiff } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { hasPreparedPaths, isPreparedPath, type PreparedPaths } from './worktreePreparation'

/** Rows returned before the list reports itself truncated. */
export const DEFAULT_CHANGE_LIMIT = 500

/** Bytes of patch returned before it is cut short. */
export const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024

export const DEFAULT_DIFF_CONTEXT_LINES = 3

/** Untracked files a whole-worktree patch shows before it stops; each costs a `git diff --no-index` process. */
export const DEFAULT_DIFF_UNTRACKED_LIMIT = 100

/**
 * Reads the NUL-separated records of `status --porcelain=v2 -z`. A rename is two
 * records (the entry, then the path it came from), hence the index loop.
 */
export function parseChangeRecords(raw: string): WorktreeChange[] {
  const records = raw.split('\0').filter((record) => record.length > 0)
  const changes: WorktreeChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    const marker = record[0]

    if (marker === '#' || marker === '!') continue

    if (marker === '?') {
      changes.push({ path: record.slice(2), kind: 'untracked', staged: false, unstaged: true })
      continue
    }

    if (marker === 'u') {
      // "u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const path = fieldsAfter(record, 10)
      if (path) changes.push({ path, kind: 'conflicted', staged: false, unstaged: true })
      continue
    }

    if (marker !== '1' && marker !== '2') continue

    const states = record.slice(2, 4)
    const stagedCode = states[0] ?? '.'
    const unstagedCode = states[1] ?? '.'
    // Ordinary entries carry 8 fields before the path; a rename or copy carries
    // a ninth, the similarity score.
    const path = fieldsAfter(record, marker === '2' ? 9 : 8)
    if (!path) continue

    const change: WorktreeChange = {
      path,
      kind: changeKind(stagedCode, unstagedCode),
      staged: stagedCode !== '.',
      unstaged: unstagedCode !== '.'
    }

    if (marker === '2') {
      // The record that follows is the original path, not a change of its own.
      const from = records[index + 1]
      index += 1
      if (from !== undefined) change.from = from
    }

    changes.push(change)
  }

  return changes
}

/**
 * The one word for a change that is often two: `A` in the index and `M` in the
 * tree is "added" to a reviewer, and both flags still say the rest.
 */
function changeKind(stagedCode: string, unstagedCode: string): WorktreeChangeKind {
  const code = stagedCode !== '.' ? stagedCode : unstagedCode
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typeChanged'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/** Everything after the first `count` space-separated fields, unsplit. */
function fieldsAfter(record: string, count: number): string | undefined {
  let offset = 0
  for (let field = 0; field < count; field += 1) {
    const next = record.indexOf(' ', offset)
    if (next === -1) return undefined
    offset = next + 1
  }
  return offset < record.length ? record.slice(offset) : undefined
}

/**
 * Review order: conflicts, then staged, then the rest, alphabetical inside each.
 * Stable order matters most — rows that jump under the cursor are unusable.
 */
export function sortChanges(changes: readonly WorktreeChange[]): WorktreeChange[] {
  const rank = (change: WorktreeChange): number => {
    if (change.kind === 'conflicted') return 0
    if (change.kind === 'untracked') return 3
    if (change.staged) return 1
    return 2
  }
  return [...changes].sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path))
}

/**
 * Drops what teamree put in the checkout itself. git cannot know the linked
 * directories and copied files were not written here; counting them opens every new worktree dirty.
 */
export function withoutPreparedPaths(
  changes: readonly WorktreeChange[],
  prepared: PreparedPaths | undefined
): WorktreeChange[] {
  if (!hasPreparedPaths(prepared)) return [...changes]
  return changes.filter((change) => !isPreparedPath(prepared, change.path, change.kind === 'untracked'))
}

export type ChangesReadOptions = {
  worktreeId: string
  worktreePath: string
  /** Restricts the list to one path. */
  path?: string
  limit?: number
  /** What this project carries into every worktree, and so is not a change. */
  prepared?: PreparedPaths
  signal?: AbortSignal
  now?: () => number
}

export async function readWorktreeChanges(runner: GitRunner, options: ChangesReadOptions): Promise<WorktreeChanges> {
  const limit = options.limit ?? DEFAULT_CHANGE_LIMIT
  // `--untracked-files=normal` is pinned: people set `status.showUntrackedFiles=no`
  // in ~/.gitconfig for a large repository, and this read would then answer
  // "nothing untracked" for a checkout whose status chip says otherwise.
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=normal', ...pathspec(options.path)],
    cwd: options.worktreePath,
    readOnly: true,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 30_000
  })

  const all = sortChanges(withoutPreparedPaths(parseChangeRecords(stdout), options.prepared))
  return {
    worktreeId: options.worktreeId,
    changes: all.slice(0, limit),
    total: all.length,
    limit,
    truncated: all.length > limit,
    readAt: (options.now ?? Date.now)()
  }
}

export type DiffReadOptions = {
  worktreeId: string
  worktreePath: string
  path?: string
  staged?: boolean
  /** A commit to diff against instead of the index, or HEAD when staged. */
  against?: string
  contextLines?: number
  maxBytes?: number
  /** Untracked files the whole-worktree patch will show. */
  untrackedLimit?: number
  /** What this project carries into every worktree, and so is not a change. */
  prepared?: PreparedPaths
  /** The platform's empty file, for diffing something git is not tracking. */
  nullDevice?: string
  signal?: AbortSignal
  now?: () => number
}

/**
 * The patch for a worktree, or for one path in it. `git diff` says nothing about
 * an untracked file, so each is diffed `--no-index` against the platform's empty
 * file (exit 1 on a difference, hence `tryRun`) and glued on after git's own patch.
 */
export async function readWorktreeDiff(runner: GitRunner, options: DiffReadOptions): Promise<WorktreeDiff> {
  const staged = options.staged ?? false
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_BYTES
  const context = options.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES
  const nullDevice = options.nullDevice ?? (process.platform === 'win32' ? 'NUL' : '/dev/null')

  const args = [
    'diff',
    '--no-color',
    `--unified=${context}`,
    ...(staged ? ['--cached'] : []),
    ...(options.against === undefined ? [] : [options.against]),
    ...pathspec(options.path)
  ]

  // One byte past the budget is enough to know the patch overflows. A 40MB log
  // read whole used to overrun the runner's hard cap and render as "No patch for this path".
  const stdoutLimitBytes = maxBytes + 1

  const { stdout } = await runner.run({
    args,
    cwd: options.worktreePath,
    readOnly: true,
    stdoutLimitBytes,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 60_000
  })

  let patch = stdout
  let cutShort = false

  // Nothing is untracked in the index, so a staged patch is already complete.
  if (!staged) {
    let untracked: string[] = []
    // An empty patch for a path is as likely an untouched file as an untracked one; only status tells them apart.
    if (options.path === undefined || !patch) {
      const listed = await listUntrackedFiles(runner, options)
      untracked = listed.paths
      cutShort = listed.cutShort
    }

    for (const file of untracked) {
      if (Buffer.byteLength(patch, 'utf8') > maxBytes) {
        cutShort = true
        break
      }
      patch += await addedFilePatch(runner, {
        file,
        context,
        nullDevice,
        stdoutLimitBytes,
        cwd: options.worktreePath,
        ...(options.signal ? { signal: options.signal } : {})
      })
    }
  }

  const truncated = cutShort || Buffer.byteLength(patch, 'utf8') > maxBytes
  return {
    worktreeId: options.worktreeId,
    ...(options.path === undefined ? {} : { path: options.path }),
    staged,
    patch: truncated ? cutToBytes(patch, maxBytes) : patch,
    truncated,
    readAt: (options.now ?? Date.now)()
  }
}

/**
 * The untracked files a patch carries, under its path if it has one.
 * `--untracked-files=all`: a patch of a directory is not a thing.
 */
async function listUntrackedFiles(
  runner: GitRunner,
  options: DiffReadOptions
): Promise<{ paths: string[]; cutShort: boolean }> {
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=all', ...pathspec(options.path)],
    cwd: options.worktreePath,
    readOnly: true,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 30_000
  })

  const paths = withoutPreparedPaths(parseChangeRecords(stdout), options.prepared)
    .filter((change) => change.kind === 'untracked')
    .map((change) => change.path)
    .sort((left, right) => left.localeCompare(right))

  const limit = options.untrackedLimit ?? DEFAULT_DIFF_UNTRACKED_LIMIT
  return { paths: paths.slice(0, limit), cutShort: paths.length > limit }
}

function pathspec(path: string | undefined): string[] {
  return path === undefined ? [] : ['--', path]
}

/**
 * The add-everything hunk for one file git is not tracking. Exit 1 is "there was a
 * difference"; higher is a real failure and contributes nothing. A clipped read has
 * the difference in hand already. Binary content is left to git's one-liner.
 */
async function addedFilePatch(
  runner: GitRunner,
  spec: {
    file: string
    context: number
    nullDevice: string
    stdoutLimitBytes: number
    cwd: string
    signal?: AbortSignal
  }
): Promise<string> {
  const attempt = await runner.tryRun({
    args: ['diff', '--no-color', `--unified=${spec.context}`, '--no-index', '--', spec.nullDevice, spec.file],
    cwd: spec.cwd,
    readOnly: true,
    stdoutLimitBytes: spec.stdoutLimitBytes,
    ...(spec.signal ? { signal: spec.signal } : {}),
    timeoutMs: 60_000
  })
  if (attempt.stdoutClipped === true || attempt.exitCode <= 1) return attempt.stdout
  return ''
}

/**
 * Cuts to a byte ceiling without splitting a character, then back to the last whole
 * line. The cut is walked off any continuation byte before decoding, since a byte
 * offset in the middle of a character decodes to a replacement character.
 */
export function cutToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text

  let end = maxBytes
  // 0b10xxxxxx is the middle of a character; the byte that starts it is earlier.
  while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1

  const cut = buffer.subarray(0, end).toString('utf8')
  const lastNewline = cut.lastIndexOf('\n')
  return lastNewline === -1 ? cut : cut.slice(0, lastNewline + 1)
}
