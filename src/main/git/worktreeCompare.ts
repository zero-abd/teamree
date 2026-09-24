// Two runs of one task, read-only: each worktree's working tree against the commit both started from.

import type { WorktreeCompare, WorktreeCompareSide } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { readWorktreeDiff } from './worktreeChanges'
import type { PreparedPaths } from './worktreePreparation'

export type CompareRun = { worktreeId: string; worktreePath: string }

export type CompareReadOptions = {
  left: CompareRun
  right: CompareRun
  contextLines?: number
  /** Ceiling on each side's patch. */
  maxBytes?: number
  prepared?: PreparedPaths
  signal?: AbortSignal
  now?: () => number
}

export async function readCompare(runner: GitRunner, options: CompareReadOptions): Promise<WorktreeCompare> {
  const signal = options.signal ? { signal: options.signal } : {}
  const head = async (run: CompareRun): Promise<string> => {
    const { stdout } = await runner.run({
      args: ['rev-parse', '--verify', 'HEAD^{commit}'],
      cwd: run.worktreePath,
      readOnly: true,
      timeoutMs: 30_000,
      ...signal
    })
    return stdout.trim()
  }
  const [leftHead, rightHead] = await Promise.all([head(options.left), head(options.right)])

  // Worktrees of one repository share its objects, so the other run's head resolves from this one.
  const found = await runner.tryRun({
    args: ['merge-base', leftHead, rightHead],
    cwd: options.left.worktreePath,
    readOnly: true,
    timeoutMs: 30_000,
    ...signal
  })
  const base = found.stdout.trim()
  if (found.exitCode !== 0 || base === '') {
    throw new GitServiceError(ErrorCode.Conflict, 'these worktrees have no commit in common')
  }

  const side = async (run: CompareRun, runHead: string): Promise<WorktreeCompareSide> => {
    const diff = await readWorktreeDiff(runner, {
      worktreeId: run.worktreeId,
      worktreePath: run.worktreePath,
      against: base,
      ...(options.contextLines === undefined ? {} : { contextLines: options.contextLines }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.prepared === undefined ? {} : { prepared: options.prepared }),
      ...signal
    })
    return { worktreeId: run.worktreeId, head: runHead, patch: diff.patch, truncated: diff.truncated }
  }
  const [left, right] = await Promise.all([side(options.left, leftHead), side(options.right, rightHead)])
  return { base, left, right, readAt: (options.now ?? Date.now)() }
}
