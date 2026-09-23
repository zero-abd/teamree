// Would this worktree merge cleanly, and if not, what fights? `git merge-tree
// --write-tree` answers without touching a working tree: it merges in memory,
// writes an unreferenced tree, and reports what conflicted.

import type { WorktreeMergePreview } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'

/**
 * The porcelain in `-z` form: one NUL-terminated tree oid, the conflicted paths,
 * an empty entry, then prose. A clean merge stops after the oid.
 */
export function parseMergeTree(raw: string): { tree: string; conflicts: string[] } {
  const records = raw.split('\0')
  const tree = records[0] ?? ''
  const conflicts: string[] = []
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] as string
    // The empty record closes the file list; everything after it is prose.
    if (record === '') break
    conflicts.push(record)
  }
  // The same path conflicts once per reason (a modify/delete reports the conflict
  // and the resolution it chose); a list that repeats reads as more damage.
  return { tree, conflicts: [...new Set(conflicts)] }
}

/**
 * Older git has `merge-tree` but not `--write-tree`. English wordings first, then
 * the shape that survives translation: git does not translate its own flag spellings.
 */
export function lacksWriteTree(stderr: string): boolean {
  return (
    // git spells it "write-tree" with no dashes, "--write-tree", or quoted either way.
    /(?:unknown|invalid|unrecognized) option[:\s]+[`']?-{0,2}write-tree[`']?/i.test(stderr) ||
    /unknown rev [`']?--write-tree[`']?/i.test(stderr) ||
    /usage:\s*git merge-tree\s+<base-tree>/i.test(stderr) ||
    (/\bgit merge-tree\b/.test(stderr) && /\bwrite-tree\b/.test(stderr))
  )
}

export type MergePreviewOptions = {
  worktreeId: string
  /** Where the merge would be run: the primary checkout, not the worktree. */
  repoPath: string
  /** What it would merge into, e.g. "origin/main". */
  baseRef: string
  /** The worktree's branch. */
  branch: string
  signal?: AbortSignal
  now?: () => number
}

/**
 * Whether this branch would merge into the base ref, and what would conflict.
 * Every answer it cannot give is named: "no conflicts" and "could not tell" look identical to a caller.
 */
export async function readMergePreview(runner: GitRunner, options: MergePreviewOptions): Promise<WorktreeMergePreview> {
  const readAt = (options.now ?? Date.now)()
  const base = { worktreeId: options.worktreeId, baseRef: options.baseRef, readAt, ahead: 0 }
  const run = { cwd: options.repoPath, readOnly: true, timeoutMs: 60_000 } as const
  const signal = options.signal ? { signal: options.signal } : {}

  // Four git commands take these names as bare positionals, and a name beginning
  // with a dash is an option — which `git check-ref-format` allows, so `detectBaseRef`
  // can hand over a base ref a remote chose. `unavailable` rather than a throw, as every answer here.
  for (const [ref, label] of [
    [options.baseRef, 'base ref'],
    [options.branch, 'branch']
  ] as const) {
    try {
      assertRefShape(ref, label)
    } catch {
      return {
        ...base,
        state: 'unavailable',
        conflicts: [],
        reason: `${label} "${ref}" is not a usable git ref, so nothing can be merged against it`
      }
    }
  }

  const resolved = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${options.baseRef}^{commit}`],
    ...run,
    ...signal
  })
  if (resolved.exitCode !== 0) {
    return {
      ...base,
      state: 'unavailable',
      conflicts: [],
      reason: `base ref "${options.baseRef}" does not resolve; fetch the remote or set another base`
    }
  }

  const mergeBase = await runner.tryRun({
    args: ['merge-base', options.baseRef, options.branch],
    ...run,
    ...signal
  })
  if (mergeBase.exitCode !== 0) {
    // No common ancestor at all. git can still merge these with
    // --allow-unrelated-histories, but nothing about that is a preview.
    return {
      ...base,
      state: 'unrelated',
      conflicts: [],
      reason: `"${options.branch}" and "${options.baseRef}" share no history`
    }
  }

  // A branch with nothing the base lacks needs no `merge-tree` process.
  const counted = await runner.tryRun({
    args: ['rev-list', '--count', `${options.baseRef}..${options.branch}`],
    ...run,
    ...signal
  })
  const ahead = counted.exitCode === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0
  if (counted.exitCode === 0 && ahead === 0) {
    return {
      ...base,
      state: 'nothingToMerge',
      conflicts: [],
      reason: `${options.branch} has nothing ${options.baseRef} does not already have`
    }
  }

  const merged = await runner.tryRun({
    args: [
      'merge-tree',
      '-z',
      '--write-tree',
      '--name-only',
      `--merge-base=${mergeBase.stdout.trim()}`,
      options.baseRef,
      options.branch
    ],
    ...run,
    ...signal
  })

  // 0 is a clean merge and 1 is conflicts; anything above that is git refusing
  // to answer, and the only one worth explaining is a version that cannot.
  if (merged.exitCode > 1) {
    return {
      ...base,
      ahead,
      state: 'unavailable',
      conflicts: [],
      reason: lacksWriteTree(merged.stderr)
        ? 'this git is too old to preview a merge without checking one out (needs 2.38)'
        : firstLine(merged.stderr) || 'git could not preview the merge'
    }
  }

  const { conflicts } = parseMergeTree(merged.stdout)
  // Trust the exit code over the parse: a clean merge writes no file list.
  if (merged.exitCode === 0) return { ...base, ahead, state: 'clean', conflicts: [] }
  return { ...base, ahead, state: 'conflicts', conflicts }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}
