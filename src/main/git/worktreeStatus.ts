// Live git state for one worktree, shaped for polling.
//
// One `git status --porcelain=v2 --branch` answers every counter at once, which
// is the whole reason for choosing v2 over plumbing several commands together.
// A second command runs only in the one case v2 cannot cover: a branch with no
// upstream, where `branch.ab` is absent and ahead/behind are measured against
// the project's base ref instead.

import type { WorktreeStatus } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { assertRefShape, comparesAgainstItself } from './repository'
import { isPreparedPath, type PreparedPaths } from './worktreePreparation'

export type ParsedStatus = {
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Ignored entries, a wholly ignored directory counting as one. */
  ignored: number
  /** The first few of them by name, for a sentence a person can act on. */
  ignoredPaths: string[]
}

const DETACHED = '(detached)'

/** Enough names to recognise a checkout by; the count carries the rest. */
export const IGNORED_SAMPLE_LIMIT = 6

/**
 * Asked of git whenever ignored entries are wanted.
 *
 * `traditional` collapses a wholly ignored directory into a single entry, so
 * neither the walk nor the output grows with what is inside node_modules — but
 * only while untracked files are listed normally, which is why that is pinned
 * here rather than left to whatever `status.showUntrackedFiles` says.
 *
 * `-z` is not an optimisation either. Without it git C-quotes any path with a
 * space or a non-ASCII byte in it, and these paths are compared against the
 * project's carried-over list and shown to the user by name.
 */
const IGNORED_ARGS = ['-z', '--ignored=traditional', '--untracked-files=normal']

export function parsePorcelainV2(raw: string, prepared?: PreparedPaths): ParsedStatus {
  const parsed: ParsedStatus = {
    branch: '',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    ignored: 0,
    ignoredPaths: []
  }

  const { records, nulSeparated } = splitRecords(raw)
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    const marker = record[0]

    if (marker === '#') {
      applyHeader(parsed, record)
      continue
    }
    if (marker === '?') {
      // The same question the change list asks, asked the same way: a checkout
      // teamree linked `node_modules` into is not a checkout the developer has
      // touched, and a chip that says otherwise is wrong on every new worktree.
      if (!isPreparedPath(prepared, record.slice(2), true)) parsed.untracked += 1
      continue
    }
    if (marker === '!') {
      // Never a change — but `git worktree remove` deletes these along with
      // everything else, and counts that leave them out are why it can.
      parsed.ignored += 1
      if (parsed.ignoredPaths.length < IGNORED_SAMPLE_LIMIT) parsed.ignoredPaths.push(record.slice(2))
      continue
    }
    if (marker === 'u') {
      // Unmerged paths are their own bucket: showing them as both staged and
      // unstaged would double-count the one thing the user must resolve.
      parsed.conflicted += 1
      continue
    }
    if (marker === '1' || marker === '2') {
      // "1 <XY> ..." / "2 <XY> ..." — X is the index state, Y the worktree
      // state, '.' meaning unchanged.
      const indexState = record[2]
      const worktree = record[3]
      if (indexState && indexState !== '.') parsed.staged += 1
      if (worktree && worktree !== '.') parsed.unstaged += 1
      // Under `-z` the record after a rename is the path it came from, not a
      // second change; on one line per record git puts it after a tab on the
      // same one. Consuming it here is what keeps it out of the counts.
      if (marker === '2' && nulSeparated) index += 1
    }
  }

  return parsed
}

/**
 * The records of a status stream, however it was asked for.
 *
 * `-z` is what the reads in this file ask for, and its records are separated by
 * a byte that cannot occur in a path — so nothing is quoted and nothing needs
 * unquoting. A stream arriving one record per line is still read, because a
 * line ending is the one thing that differs between platforms and a parser that
 * only understood one of them would be a Windows-only bug nobody could see.
 */
function splitRecords(raw: string): { records: string[]; nulSeparated: boolean } {
  // No path can hold a NUL, so its presence says which spelling this is.
  const nulSeparated = raw.includes('\0')
  const lines = nulSeparated
    ? raw.split('\0')
    : raw.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  return { records: lines.filter((line) => line.length > 0), nulSeparated }
}

function applyHeader(parsed: ParsedStatus, line: string): void {
  if (line.startsWith('# branch.head ')) {
    const value = line.slice('# branch.head '.length).trim()
    parsed.detached = value === DETACHED
    parsed.branch = parsed.detached ? '' : value
    return
  }
  if (line.startsWith('# branch.upstream ')) {
    parsed.upstream = line.slice('# branch.upstream '.length).trim() || null
    return
  }
  if (line.startsWith('# branch.ab ')) {
    // "+3 -1"
    const [ahead, behind] = line.slice('# branch.ab '.length).trim().split(' ')
    parsed.ahead = Number.parseInt(ahead?.replace('+', '') ?? '0', 10) || 0
    parsed.behind = Math.abs(Number.parseInt(behind?.replace('-', '') ?? '0', 10) || 0)
  }
}

export type StatusReadOptions = {
  worktreeId: string
  worktreePath: string
  /** Recorded branch, used when git reports a detached HEAD. */
  fallbackBranch: string
  /** Compared against when the branch has no upstream. */
  baseRef?: string
  /** What this project carries into every worktree, and so is not a change. */
  prepared?: PreparedPaths
  signal?: AbortSignal
  now?: () => number
}

export async function readWorktreeStatus(runner: GitRunner, options: StatusReadOptions): Promise<WorktreeStatus> {
  const { stdout } = await runner.run({
    // The ignored entries cost nothing extra to ask for: git has already
    // decided which untracked paths an ignore rule covers in order to leave
    // them out, so this only changes whether it says so.
    args: ['status', '--porcelain=v2', '--branch', ...IGNORED_ARGS],
    cwd: options.worktreePath,
    readOnly: true,
    signal: options.signal,
    timeoutMs: 30_000
  })
  const parsed = parsePorcelainV2(stdout, options.prepared)

  if (!parsed.upstream && options.baseRef) {
    const divergence = await readDivergence(runner, options.worktreePath, options.baseRef, options.signal)
    if (divergence) {
      parsed.ahead = divergence.ahead
      parsed.behind = divergence.behind
    }
  }

  return {
    worktreeId: options.worktreeId,
    branch: parsed.branch || options.fallbackBranch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    ignored: parsed.ignored,
    readAt: (options.now ?? Date.now)()
  }
}

/** Ignored entries in a checkout: how many, and the first few by name. */
export type IgnoredEntries = { count: number; names: string[] }

/**
 * What removing this checkout would delete that nothing has told the user
 * about: the `.env`, the local database, the virtualenv an agent built.
 *
 * Read on its own rather than off a status the caller happens to hold, because
 * the answer decides whether a directory is destroyed and a status is a cache.
 */
export async function readIgnoredEntries(
  runner: GitRunner,
  options: { worktreePath: string; signal?: AbortSignal }
): Promise<IgnoredEntries> {
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', ...IGNORED_ARGS],
    cwd: options.worktreePath,
    readOnly: true,
    signal: options.signal,
    timeoutMs: 60_000
  })
  const parsed = parsePorcelainV2(stdout)
  return { count: parsed.ignored, names: parsed.ignoredPaths }
}

/** `--left-right` prints "<behind>\t<ahead>" for `base...HEAD`. */
async function readDivergence(
  runner: GitRunner,
  cwd: string,
  baseRef: string,
  signal?: AbortSignal
): Promise<{ ahead: number; behind: number } | null> {
  // `HEAD...HEAD` is the branch against itself: it exits 0 and counts "0 0",
  // which would be published as a confident "in sync" for a branch nobody has
  // compared against anything.
  if (comparesAgainstItself(baseRef)) return null
  try {
    assertRefShape(baseRef, 'base ref')
  } catch {
    return null
  }
  const result = await runner.tryRun({
    args: ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`],
    cwd,
    readOnly: true,
    signal,
    timeoutMs: 30_000
  })
  if (result.exitCode !== 0) return null // unborn branch, or a base ref this checkout cannot see
  const [behind, ahead] = result.stdout.trim().split(/\s+/)
  return {
    ahead: Number.parseInt(ahead ?? '0', 10) || 0,
    behind: Number.parseInt(behind ?? '0', 10) || 0
  }
}
