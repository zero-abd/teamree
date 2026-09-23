// Throwing away working-tree changes: a whole path, or one hunk of it. The index
// is never written, so what is staged survives; an untracked file goes to the Trash.

import path from 'node:path'
import type { WorktreeChange, WorktreeDiscard } from '../../shared/entities'
import type { HunkInput } from '../../shared/methods'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { parseChangeRecords } from './worktreeChanges'
import { assertCarriablePath, hunkPatch } from './worktreeHunk'

const DISCARD_TIMEOUT_MS = 60_000

/** Moves one absolute path to the Trash; `shell.trashItem` in the app. */
export type Trash = (absolutePath: string) => Promise<void>

export type DiscardOptions = {
  worktreeId: string
  worktreePath: string
  path: string
  /** Absent, an untracked file is refused rather than deleted. */
  trash?: Trash
  signal?: AbortSignal
  now?: () => number
}

export type HunkDiscardOptions = Omit<DiscardOptions, 'trash'> & { hunk: HunkInput }

/** Puts a path back to its staged (else committed) content; an untracked file goes to the Trash. */
export async function discardPath(runner: GitRunner, options: DiscardOptions): Promise<WorktreeDiscard> {
  const absolute = insideWorktree(options)
  const change = await unstagedChange(runner, options)
  if (change.kind === 'untracked') {
    if (options.trash === undefined) throw refusal(`no Trash here for ${options.path}`)
    await options.trash(absolute)
    return receipt(options, 'trashed')
  }
  // Pathspecs read literally, so `*.ts` restores the file of that name and nothing else.
  await runner.run({
    args: ['--literal-pathspecs', 'restore', '--worktree', '--', options.path],
    cwd: options.worktreePath,
    timeoutMs: DISCARD_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {})
  })
  return receipt(options, 'restored')
}

/** Reverses one hunk of the unstaged patch out of the file on disk. */
export async function discardHunk(runner: GitRunner, options: HunkDiscardOptions): Promise<WorktreeDiscard> {
  insideWorktree(options)
  assertCarriablePath(options.path)
  const patch = hunkPatch(options.path, options.hunk)
  const change = await unstagedChange(runner, options)
  if (change.kind === 'untracked') throw refusal(`${options.path} is untracked; discard the file`)

  const zeroContext = options.hunk.lines.every((line) => line.kind !== 'context')
  // `nowarn`: `apply.whitespace=fix` would rewrite the lines a reverse puts back.
  const common = ['--whitespace=nowarn', ...(zeroContext ? ['--unidiff-zero'] : []), '-']
  const apply = (args: readonly string[], readOnly: boolean): ReturnType<GitRunner['tryRun']> =>
    runner.tryRun({
      args: ['apply', ...args, ...common],
      cwd: options.worktreePath,
      stdin: patch,
      readOnly,
      timeoutMs: DISCARD_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {})
    })

  // Both sides checked before anything is written: the old side must be what the
  // index holds (so a staged hunk is refused) and the new side what is on disk.
  const fromIndex = await apply(['--cached', '--check'], true)
  const onDisk = await apply(['--reverse', '--check'], true)
  if (fromIndex.exitCode !== 0 || onDisk.exitCode !== 0) {
    throw refusal(`${options.path} changed since that patch was read`, (fromIndex.stderr + onDisk.stderr).trim())
  }
  const applied = await apply(['--reverse'], false)
  if (applied.exitCode !== 0) throw refusal(`that hunk no longer applies to ${options.path}`, applied.stderr.trim())
  return receipt(options, 'hunk')
}

/**
 * The absolute path, refusing anything but a relative path with no `..` in it. Lexical on
 * purpose: git lists nothing beneath a symlink, and a symlink itself is trashed, not its target.
 */
function insideWorktree(options: { worktreePath: string; path: string }): string {
  const parts = options.path.split(/[\\/]/)
  if (path.isAbsolute(options.path) || parts.includes('..') || parts.every((part) => part === '' || part === '.')) {
    throw new GitServiceError(ErrorCode.InvalidParams, `${options.path} is not a path in this worktree`)
  }
  return path.join(options.worktreePath, options.path)
}

/** Git's own record of the path's unstaged change, refusing the kinds nothing here may throw away. */
async function unstagedChange(
  runner: GitRunner,
  options: { worktreePath: string; path: string; signal?: AbortSignal }
): Promise<WorktreeChange> {
  const { stdout } = await runner.run({
    args: ['--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', options.path],
    cwd: options.worktreePath,
    readOnly: true,
    timeoutMs: 30_000,
    ...(options.signal ? { signal: options.signal } : {})
  })
  const change = parseChangeRecords(stdout).find((entry) => entry.path === options.path && entry.unstaged)
  if (change === undefined) throw refusal(`nothing unstaged in ${options.path}`)
  if (change.kind === 'conflicted') throw refusal(`resolve the conflict in ${options.path} first`)
  // Intent-to-add: the index holds an empty blob, which `restore` would write over the file.
  if (change.kind === 'added' && !change.staged) throw refusal(`${options.path} is intent-to-add; unstage it first`)
  return change
}

function refusal(message: string, stderr?: string): GitServiceError {
  return new GitServiceError(ErrorCode.Conflict, message, stderr === undefined ? undefined : { stderr })
}

function receipt(options: DiscardOptions | HunkDiscardOptions, outcome: WorktreeDiscard['outcome']): WorktreeDiscard {
  return { worktreeId: options.worktreeId, path: options.path, outcome, discardedAt: (options.now ?? Date.now)() }
}
