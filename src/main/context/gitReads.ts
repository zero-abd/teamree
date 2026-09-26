// The git the ledger reads: paths a worktree touched, whether two branches
// would conflict, and what a landing merge had to resolve. Read-only throughout.

import type { GitRunner } from '../git/gitProcess'
import { parseMergeTree } from '../git/mergePreview'
import { MAX_TOUCHED } from './ledgerStore'

const TIMEOUT_MS = 20_000

export type GitTouches = {
  tip: string
  /** Commits on HEAD the base lacks. */
  ahead: number
  committed: string[]
  uncommitted: string[]
}

function usableRef(ref: string): boolean {
  return ref !== '' && !ref.startsWith('-') && !/\s/.test(ref)
}

function nulList(raw: string): string[] {
  return raw.split('\0').filter((entry) => entry !== '')
}

/** Paths from `status --porcelain -z`; a rename counts under its new name. */
export function parseStatusPaths(raw: string): string[] {
  const records = raw.split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    if (record.length < 4) continue
    paths.push(record.slice(3))
    // The original path of a rename or copy follows as its own record.
    if (record[0] === 'R' || record[0] === 'C') index += 1
  }
  return paths
}

/** Undefined when git cannot say: a checkout gone from disk, a base that does not resolve. */
export async function readTouches(
  runner: GitRunner,
  options: { cwd: string; base: string }
): Promise<GitTouches | undefined> {
  if (!usableRef(options.base)) return undefined
  const run = { cwd: options.cwd, readOnly: true, timeoutMs: TIMEOUT_MS } as const
  try {
    const head = await runner.tryRun({ args: ['rev-parse', '--verify', '--quiet', 'HEAD'], ...run })
    if (head.exitCode !== 0) return undefined
    const counted = await runner.tryRun({ args: ['rev-list', '--count', `${options.base}..HEAD`], ...run })
    if (counted.exitCode !== 0) return undefined
    const ahead = Number.parseInt(counted.stdout.trim(), 10) || 0
    const committed =
      ahead === 0
        ? []
        : nulList(
            (await runner.run({ args: ['diff', '--name-only', '-z', `${options.base}...HEAD`, '--'], ...run })).stdout
          )
    const status = await runner.run({ args: ['status', '--porcelain', '-z', '--untracked-files=all'], ...run })
    return {
      tip: head.stdout.trim(),
      ahead,
      committed: committed.slice(0, MAX_TOUCHED),
      uncommitted: parseStatusPaths(status.stdout).slice(0, MAX_TOUCHED)
    }
  } catch {
    return undefined
  }
}

/** Paths a merge of the two commits would stop on; undefined when git cannot tell. */
export async function mergeConflicts(
  runner: GitRunner,
  options: { cwd: string; left: string; right: string }
): Promise<string[] | undefined> {
  if (!usableRef(options.left) || !usableRef(options.right)) return undefined
  const run = { cwd: options.cwd, readOnly: true, timeoutMs: TIMEOUT_MS } as const
  try {
    const base = await runner.tryRun({ args: ['merge-base', options.left, options.right], ...run })
    if (base.exitCode !== 0) return undefined
    const merged = await runner.tryRun({
      args: [
        'merge-tree',
        '-z',
        '--write-tree',
        '--name-only',
        `--merge-base=${base.stdout.trim()}`,
        options.left,
        options.right
      ],
      ...run
    })
    if (merged.exitCode > 1) return undefined
    return merged.exitCode === 0 ? [] : parseMergeTree(merged.stdout).conflicts
  } catch {
    return undefined
  }
}

export async function isAncestor(runner: GitRunner, cwd: string, commit: string, of: string): Promise<boolean> {
  if (!usableRef(commit) || !usableRef(of)) return false
  try {
    const probe = await runner.tryRun({
      args: ['merge-base', '--is-ancestor', commit, of],
      cwd,
      readOnly: true,
      timeoutMs: TIMEOUT_MS
    })
    return probe.exitCode === 0
  } catch {
    return false
  }
}

/**
 * What the merge that brought `tip` into `base` had to resolve: the first merge
 * on the ancestry path, replayed with merge-tree. A fast-forward resolved nothing.
 */
export async function landingConflicts(
  runner: GitRunner,
  options: { cwd: string; tip: string; base: string }
): Promise<string[]> {
  if (!usableRef(options.tip) || !usableRef(options.base)) return []
  const run = { cwd: options.cwd, readOnly: true, timeoutMs: TIMEOUT_MS } as const
  try {
    const merges = await runner.run({
      args: ['rev-list', '--merges', '--ancestry-path', '--reverse', `${options.tip}..${options.base}`],
      ...run,
      stdoutLimitBytes: 1_000_000
    })
    const merge = merges.stdout.split('\n')[0]?.trim()
    if (!merge) return []
    const parents = (await runner.run({ args: ['rev-list', '--parents', '-n', '1', merge], ...run })).stdout
      .trim()
      .split(' ')
      .slice(1)
    const [mainline, incoming] = parents
    if (mainline === undefined || incoming === undefined) return []
    // Already on the mainline before this merge: it arrived by a fast-forward.
    if (await isAncestor(runner, options.cwd, options.tip, mainline)) return []
    return (await mergeConflicts(runner, { cwd: options.cwd, left: mainline, right: incoming })) ?? []
  } catch {
    return []
  }
}
