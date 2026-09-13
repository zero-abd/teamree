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
 */
const IGNORED_ARGS = ['--ignored=traditional', '--untracked-files=normal']

export function parsePorcelainV2(raw: string): ParsedStatus {
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

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) continue
    const marker = line[0]

    if (marker === '#') {
      applyHeader(parsed, line)
      continue
    }
    if (marker === '?') {
      parsed.untracked += 1
      continue
    }
    if (marker === '!') {
      // Never a change — but `git worktree remove` deletes these along with
      // everything else, and counts that leave them out are why it can.
      parsed.ignored += 1
      if (parsed.ignoredPaths.length < IGNORED_SAMPLE_LIMIT) parsed.ignoredPaths.push(line.slice(2))
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
      const index = line[2]
      const worktree = line[3]
      if (index && index !== '.') parsed.staged += 1
      if (worktree && worktree !== '.') parsed.unstaged += 1
    }
  }

  return parsed
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
  const parsed = parsePorcelainV2(stdout)

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
