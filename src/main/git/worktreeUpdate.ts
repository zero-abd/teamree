// Bringing a worktree's branch up to date with its base: a rebase while nobody else
// has the branch, a merge once it is published. A conflict is left for the agent.

import type { WorktreeUpdate, WorktreeUpdateAbort } from '../../shared/entities'
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
