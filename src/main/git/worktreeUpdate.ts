// Bringing a worktree's branch up to date with its base: a rebase while nobody else
// has the branch, a merge once it is published. A conflict is left for the agent.

import type { WorktreeResolve, WorktreeUpdate, WorktreeUpdateAbort } from '../../shared/entities'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'
import { requireCommitIdentity } from './worktreeCommit'
import { parsePorcelainV2, readOperation } from './worktreeStatus'

export type WorktreeUpdateOptions = {
  worktreeId: string
  worktreePath: string
  baseRef: string
  now?: () => number
  signal?: AbortSignal
}

export async function updateWorktree(runner: GitRunner, options: WorktreeUpdateOptions): Promise<WorktreeUpdate> {
  const { worktreePath: cwd, baseRef, signal } = options
  assertRefShape(baseRef, 'base ref')
  const running = readOperation(cwd)
  if (running !== undefined) throw new GitServiceError(ErrorCode.Conflict, `A ${running} is in progress`)

  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
    cwd,
    readOnly: true,
    signal
  })
  const status = parsePorcelainV2(stdout)
  // Untracked files are left out: a checkout's linked `node_modules` is one, and git refuses by itself when one is in the way.
  if (status.staged + status.unstaged + status.conflicted > 0) {
    throw new GitServiceError(ErrorCode.Conflict, 'Commit or stash first')
  }
  const mode = status.upstream !== null && status.upstream !== baseRef ? 'merge' : 'rebase'
  const result = (outcome: WorktreeUpdate['outcome'], conflicts: string[] = []): WorktreeUpdate => ({
    worktreeId: options.worktreeId,
    baseRef,
    mode,
    outcome,
    conflicts,
    updatedAt: (options.now ?? Date.now)()
  })

  const behind = await runner.run({ args: ['rev-list', '--count', `HEAD..${baseRef}`], cwd, readOnly: true, signal })
  if (Number.parseInt(behind.stdout.trim(), 10) === 0) return result('upToDate')

  await requireCommitIdentity(runner, cwd, signal)
  const run = await runner.tryRun({
    args: mode === 'rebase' ? ['rebase', baseRef] : ['merge', '--no-edit', baseRef],
    cwd,
    // Nothing here may wait on an editor nobody can see.
    env: { GIT_EDITOR: 'true' },
    signal
  })
  if (run.exitCode === 0) return result('updated')

  const conflicts = await conflictedPaths(runner, cwd, signal)
  if (conflicts.length > 0 && readOperation(cwd) !== undefined) return result('conflicts', conflicts)
  // Stopped for some other reason: put the branch back rather than leave a half-done rebase behind.
  if (readOperation(cwd) !== undefined)
    await abortWorktreeUpdate(runner, { worktreeId: options.worktreeId, worktreePath: cwd })
  throw new GitServiceError(
    ErrorCode.Conflict,
    firstLine(run.stderr) || firstLine(run.stdout) || `could not ${mode} onto ${baseRef}`
  )
}

export async function abortWorktreeUpdate(
  runner: GitRunner,
  options: { worktreeId: string; worktreePath: string; signal?: AbortSignal }
): Promise<WorktreeUpdateAbort> {
  const operation = readOperation(options.worktreePath)
  if (operation === undefined) return { worktreeId: options.worktreeId, aborted: null }
  await runner.run({ args: [operation, '--abort'], cwd: options.worktreePath, signal: options.signal })
  return { worktreeId: options.worktreeId, aborted: operation }
}

export type ContinueOptions = {
  worktreeId: string
  worktreePath: string
  baseRef: string
  now?: () => number
  signal?: AbortSignal
}

/** Finishes a stopped update once nothing is unresolved: commits the merge, or goes on with the rebase, which may stop again. */
export async function continueWorktreeUpdate(runner: GitRunner, options: ContinueOptions): Promise<WorktreeUpdate> {
  const { worktreePath: cwd, signal } = options
  const mode = readOperation(cwd)
  if (mode === undefined) throw new GitServiceError(ErrorCode.Conflict, 'Nothing to continue')
  const unresolved = await conflictedPaths(runner, cwd, signal)
  if (unresolved.length > 0) throw new GitServiceError(ErrorCode.Conflict, `Resolve ${unresolved.join(', ')} first`)
  const result = (outcome: WorktreeUpdate['outcome'], conflicts: string[] = []): WorktreeUpdate => ({
    worktreeId: options.worktreeId,
    baseRef: options.baseRef,
    mode,
    outcome,
    conflicts,
    updatedAt: (options.now ?? Date.now)()
  })

  await requireCommitIdentity(runner, cwd, signal)
  // A rebased commit the resolution emptied would stop the rebase with "No changes"; git's own way on is to skip it.
  const emptied =
    mode === 'rebase' &&
    (await runner.tryRun({ args: ['diff', '--cached', '--quiet'], cwd, readOnly: true, signal })).exitCode === 0
  const args = mode === 'merge' ? ['commit', '--no-edit'] : ['rebase', emptied ? '--skip' : '--continue']
  const run = await runner.tryRun({ args, cwd, env: { GIT_EDITOR: 'true' }, signal })
  if (readOperation(cwd) === undefined && run.exitCode === 0) return result('updated')
  const conflicts = await conflictedPaths(runner, cwd, signal)
  if (conflicts.length > 0 && readOperation(cwd) !== undefined) return result('conflicts', conflicts)
  throw new GitServiceError(
    ErrorCode.Conflict,
    firstLine(run.stderr) || firstLine(run.stdout) || `could not continue the ${mode}`
  )
}

/**
 * Marks one conflicted path resolved as it stands, or after taking one side whole. `ours` is always this
 * task's side: a rebase replays the task onto the base, so there git calls it theirs.
 */
export async function resolveWorktreeConflict(
  runner: GitRunner,
  options: { worktreeId: string; worktreePath: string; path: string; take?: 'ours' | 'theirs'; signal?: AbortSignal }
): Promise<WorktreeResolve> {
  const { worktreePath: cwd, path, signal } = options
  const operation = readOperation(cwd)
  if (operation === undefined) throw new GitServiceError(ErrorCode.Conflict, 'Nothing is being updated')
  if (options.take !== undefined) {
    const swapped = operation === 'rebase'
    const side = (options.take === 'ours') !== swapped ? 'ours' : 'theirs'
    const stages = await runner.run({ args: ['ls-files', '-u', '-z', '--', path], cwd, readOnly: true, signal })
    if (stages.stdout === '') throw new GitServiceError(ErrorCode.Conflict, `${path} is not conflicted`)
    const stage = side === 'ours' ? '2' : '3'
    const present = stages.stdout.split('\0').some((entry) => entry.split('\t')[0]?.split(' ')[2] === stage)
    // A side that deleted the file is taken by deleting it.
    if (present) await runner.run({ args: ['checkout', `--${side}`, '--', path], cwd, signal })
    else {
      await runner.run({ args: ['rm', '--quiet', '--cached', '--', path], cwd, signal })
      await rm(join(cwd, path), { force: true })
      return { worktreeId: options.worktreeId, conflicts: await conflictedPaths(runner, cwd, signal) }
    }
  }
  await runner.run({ args: ['add', '--', path], cwd, signal })
  return { worktreeId: options.worktreeId, conflicts: await conflictedPaths(runner, cwd, signal) }
}

async function conflictedPaths(runner: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const listed = await runner.tryRun({
    args: ['diff', '--name-only', '--diff-filter=U', '-z'],
    cwd,
    readOnly: true,
    signal
  })
  if (listed.exitCode !== 0) return []
  return [...new Set(listed.stdout.split('\0').filter((entry) => entry !== ''))]
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('hint:')) ?? ''
  )
}
