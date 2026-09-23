// What actually changed in a worktree, rather than how much.
//
// The status chips answer "is there anything here", which is the right question
// for a sidebar and the wrong one the moment you want to commit: a count cannot
// tell you that the file you are about to include is a stray log. So this reads
// the same `git status --porcelain=v2` the counters come from, but keeps the
// paths — and then gives a way to see the patch for any of them.
//
// `-z` is not an optimisation. Without it git quotes any path containing a
// space, a quote or a non-ASCII byte, and the quoting rules are C-string rules
// that a naive reader gets subtly wrong. NUL-separated records have no quoting
// at all, so a path is whatever bytes lie between two separators.

import type { WorktreeChange, WorktreeChangeKind, WorktreeChanges, WorktreeDiff } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { hasPreparedPaths, isPreparedPath, type PreparedPaths } from './worktreePreparation'

/** Rows returned before the list reports itself truncated. */
export const DEFAULT_CHANGE_LIMIT = 500

/** Bytes of patch returned before it is cut short. */
export const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024

export const DEFAULT_DIFF_CONTEXT_LINES = 3

/**
 * Untracked files a whole-worktree patch will show before it stops adding them.
 *
 * Each one costs a `git diff --no-index`, a process apiece, so an unbounded
 * list is a minute of spawning for a patch nobody will read to the end. Past
 * the cap the diff says it is truncated, which is the same thing it says when
 * the bytes run out.
 */
export const DEFAULT_DIFF_UNTRACKED_LIMIT = 100

/**
 * Reads the NUL-separated records of `status --porcelain=v2 -z`.
 *
 * A rename record is two records: the entry, then the path it came from. That
 * is the only place the format is not one record per change, and the only
 * reason this is a loop with an index rather than a map.
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
      // The record that follows is the original path, and is not a change of
      // its own. Consuming it here is what keeps it out of the list.
      const from = records[index + 1]
      index += 1
      if (from !== undefined) change.from = from
    }

    changes.push(change)
  }

  return changes
}

/**
 * The one word for a change that is often two. A file added to the index and
 * then edited is `A` in the index and `M` in the tree; calling that "added" is
 * what a reviewer means by it, and both flags still say the rest.
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
 * Reading order, which is review order: what blocks a commit first, then what
 * is already staged, then the rest, alphabetical inside each group. A stable
 * order matters more than any particular one — the list is re-read constantly,
 * and rows that jump around under the cursor are unusable.
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
 * Drops what teamree put in the checkout itself.
 *
 * A worktree is born with the project's linked directories and copied files
 * already in it, and git has no way to know they were not written by whoever is
 * working here. Counting them as changes makes every new worktree open dirty,
 * with a row nobody can act on: the developer did not add `node_modules`, and
 * committing or discarding it is the wrong answer either way.
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
  limit?: number
  /** What this project carries into every worktree, and so is not a change. */
  prepared?: PreparedPaths
  signal?: AbortSignal
  now?: () => number
}

export async function readWorktreeChanges(runner: GitRunner, options: ChangesReadOptions): Promise<WorktreeChanges> {
  const limit = options.limit ?? DEFAULT_CHANGE_LIMIT
  // `--untracked-files=normal` is pinned, never left to the repository's own
  // `status.showUntrackedFiles`. People set that to `no` in ~/.gitconfig to
  // make status usable on a large repository, where it then covers every
  // repository they own — and this read would answer "nothing untracked" for
  // a checkout whose own status chip, which pins the flag, says otherwise.
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=normal'],
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
 * The patch for a worktree, or for one path in it.
 *
 * An untracked file is the awkward case: `git diff` has nothing to compare it
 * against and says nothing at all, which reads as "no changes" for exactly the
 * files a new branch is usually full of. `--no-index` against the platform's
 * empty file produces the add-everything patch that was wanted, and exits 1
 * because it found a difference — which is why this goes through `tryRun`.
 *
 * So the whole-worktree patch is two reads glued together: what git will diff,
 * then one add-everything hunk per untracked file. The alternative was a list
 * of three changes whose patch showed one, with nothing to say the two
 * disagreed — and the fix git's own porcelain uses for it, an intent-to-add,
 * writes to the index, which is the user's.
 */
export async function readWorktreeDiff(runner: GitRunner, options: DiffReadOptions): Promise<WorktreeDiff> {
  const staged = options.staged ?? false
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_BYTES
  const context = options.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES
  const nullDevice = options.nullDevice ?? (process.platform === 'win32' ? 'NUL' : '/dev/null')

  const base = ['diff', '--no-color', `--unified=${context}`]
  const args = staged
    ? [...base, '--cached', ...(options.path ? ['--', options.path] : [])]
    : [...base, ...(options.path ? ['--', options.path] : [])]

  // One byte past the budget is all it takes to know the patch overflows it, so
  // that is where the read stops. A 40MB log read whole only to be cut back to
  // a megabyte used to overrun the runner's hard cap and come back as a failure
  // — which the panel then rendered as "No patch for this path", an answer,
  // for a file it had simply declined to read.
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
    if (options.path === undefined) {
      const listed = await listUntrackedFiles(runner, options)
      untracked = listed.paths
      cutShort = listed.cutShort
    } else if (!patch && !isPreparedPath(options.prepared, options.path, true)) {
      untracked = [options.path]
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
 * The untracked files a whole-worktree patch should carry, in reading order.
 *
 * `--untracked-files=all` rather than `normal`: the change list names a new
 * directory once, but a patch of a directory is not a thing, so the files
 * inside it are what gets diffed.
 */
async function listUntrackedFiles(
  runner: GitRunner,
  options: DiffReadOptions
): Promise<{ paths: string[]; cutShort: boolean }> {
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
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

/**
 * The add-everything hunk for one file git is not tracking.
 *
 * Exit 1 is "there was a difference"; anything higher is a real failure,
 * including the path simply not existing, and contributes nothing. A clipped
 * read reports git's own death by signal instead, and has the difference in
 * hand already. Binary content is left to git, which writes its one-line
 * "Binary files ... differ" rather than the bytes.
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
 * Cuts a string to a byte ceiling without splitting a character in half, and
 * then back to the last whole line, because half a diff line is worse than one
 * line fewer.
 *
 * The ceiling is in bytes because that is what a caller has to budget for, and
 * a byte offset lands wherever it lands — including the middle of a multi-byte
 * character, which decodes to a replacement character rather than an error. So
 * the cut is walked back off any continuation byte before anything is decoded.
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
