// Would this worktree merge cleanly, and if not, what fights?
//
// Running several attempts at one task in parallel is the point of this app,
// and the question that follows immediately is which of them can actually go
// in. Answering it by trying the merge is the obvious approach and a bad one:
// it dirties a checkout, needs somewhere to put the result, and leaves the
// repository mid-merge when it fails — for a question that was only ever
// hypothetical.
//
// `git merge-tree --write-tree` answers it without touching any working tree at
// all. It merges two commits in memory, writes the result into the object
// database, and reports what conflicted. Nothing is checked out, no index is
// touched, and the tree it writes is unreferenced and collected later.

import type { WorktreeMergePreview } from '../../shared/entities'
import type { GitRunner } from './gitProcess'

/**
 * What the porcelain says, in the `-z` form.
 *
 * The output is one NUL-terminated tree oid, then the conflicted paths, then an
 * empty entry, then human-readable messages. A clean merge stops after the oid,
 * which is why the file list is read up to the terminator rather than to the
 * end.
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
  // The same path conflicts once per reason — a modify/delete reports both the
  // conflict and the resolution it chose — and a list that repeats itself reads
  // as more damage than there is.
  return { tree, conflicts: [...new Set(conflicts)] }
}

/**
 * Older git has `merge-tree` but not the form that answers this question.
 *
 * The English wordings are matched first because they are precise, and then
 * the shape that survives translation: a refusal that names both the command
 * and the option is this refusal whatever language the prose around it is in.
 * Git translates "unknown option" and "usage"; it does not translate the
 * spelling of its own subcommands and flags.
 */
export function lacksWriteTree(stderr: string): boolean {
  return (
    // git spells it several ways: "unknown option `write-tree'" with no dashes
    // at all, "--write-tree" with them, and quoted either way.
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
 * Whether this worktree's branch would merge into the base ref, and what would
 * conflict if it would not.
 *
 * Every answer it cannot give is named rather than guessed at. A base ref that
 * does not resolve, two histories with nothing in common, a git too old to be
 * asked — each comes back as its own state with a reason, because "no
 * conflicts" and "could not tell" look identical to a caller and mean opposite
 * things.
 */
export async function readMergePreview(runner: GitRunner, options: MergePreviewOptions): Promise<WorktreeMergePreview> {
  const readAt = (options.now ?? Date.now)()
  const base = { worktreeId: options.worktreeId, baseRef: options.baseRef, readAt, ahead: 0 }
  const run = { cwd: options.repoPath, readOnly: true, timeoutMs: 60_000 } as const
  const signal = options.signal ? { signal: options.signal } : {}

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

  // How much there is to merge at all. A branch with nothing the base lacks
  // needs no merge preview and no `merge-tree` process to say so.
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
  // Trust the exit code over the parse: a clean merge writes no file list, and
  // a conflicted one always sets 1.
  if (merged.exitCode === 0) return { ...base, ahead, state: 'clean', conflicts: [] }
  return { ...base, ahead, state: 'conflicts', conflicts }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}
