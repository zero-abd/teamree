// Staging one hunk, or unstaging a whole path: writes the index and only the index
// (`--cached`: the working tree is under an open editor). Built like `worktreeCommit`,
// to refuse rather than guess.

import type { WorktreeHunkStage, WorktreeUnstage } from '../../shared/entities'
import type { HunkInput } from '../../shared/methods'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { parseChangeRecords } from './worktreeChanges'

/** Applying a patch is a write and takes the index lock; hooks are not involved. */
const APPLY_TIMEOUT_MS = 60_000

export type HunkStageOptions = {
  worktreeId: string
  worktreePath: string
  path: string
  hunk: HunkInput
  /** True to put the hunk into the index, false to take it back out. */
  staged: boolean
  signal?: AbortSignal
  now?: () => number
}

export async function applyHunk(runner: GitRunner, options: HunkStageOptions): Promise<WorktreeHunkStage> {
  const { path, hunk } = options
  assertCarriablePath(path)
  await assertStageable(runner, options)

  const patch = hunkPatch(path, hunk)
  // Zero context is the one shape `git apply` refuses to place on its own; it
  // wants to be told the emptiness is deliberate.
  const zeroContext = hunk.lines.every((line) => line.kind !== 'context')
  const flags = [
    'apply',
    '--cached',
    ...(options.staged ? [] : ['--reverse']),
    ...(zeroContext ? ['--unidiff-zero'] : [])
  ]

  const run = async (args: readonly string[]): Promise<{ exitCode: number; stderr: string }> => {
    const { exitCode, stderr } = await runner.tryRun({
      args: [...args, '-'],
      cwd: options.worktreePath,
      stdin: patch,
      timeoutMs: APPLY_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {})
    })
    return { exitCode, stderr }
  }

  if (options.staged) await assertStillPending(runner, options, patch, zeroContext)

  // `--check` first, so the failure arrives with nothing half-applied and with
  // the message worth putting in front of somebody.
  const checked = await run([...flags, '--check'])
  if (checked.exitCode !== 0) throw stale(options.staged, path, checked.stderr)

  const applied = await run(flags)
  if (applied.exitCode !== 0) throw stale(options.staged, path, applied.stderr)

  return {
    worktreeId: options.worktreeId,
    path,
    staged: options.staged,
    added: hunk.lines.filter((line) => line.kind === 'added').length,
    removed: hunk.lines.filter((line) => line.kind === 'removed').length,
    appliedAt: (options.now ?? Date.now)()
  }
}

export type PathUnstageOptions = Omit<HunkStageOptions, 'hunk' | 'staged'>

/** `git restore --staged` for one path, and a rename's origin with it so no half stays staged. */
export async function unstagePath(runner: GitRunner, options: PathUnstageOptions): Promise<WorktreeUnstage> {
  const common = { cwd: options.worktreePath, ...(options.signal ? { signal: options.signal } : {}) }
  // No pathspec: limited to the new path, status cannot pair a rename with its origin.
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=no'],
    readOnly: true,
    timeoutMs: 30_000,
    ...common
  })
  const change = parseChangeRecords(stdout).find((entry) => entry.path === options.path && entry.staged)
  if (change === undefined) throw new GitServiceError(ErrorCode.Conflict, `nothing staged in ${options.path}.`)
  const paths = change.kind === 'renamed' && change.from !== undefined ? [change.path, change.from] : [change.path]

  // `restore` needs a HEAD; before the first commit the entry is dropped (`--force`: only the index check).
  const born = await runner.tryRun({ args: ['rev-parse', '--verify', '--quiet', 'HEAD'], readOnly: true, ...common })
  const args = born.exitCode === 0 ? ['restore', '--staged'] : ['rm', '--cached', '--force', '--quiet']
  await runner.run({ args: ['--literal-pathspecs', ...args, '--', ...paths], timeoutMs: APPLY_TIMEOUT_MS, ...common })
  return { worktreeId: options.worktreeId, path: options.path, unstagedAt: (options.now ?? Date.now)() }
}

/**
 * The check `--cached` cannot make. `git apply --cached` compares the old side
 * against the index, which nobody edits, so it passes for a hunk read four saves
 * ago and stages a version no longer on disk. So the new side is checked against
 * the working tree by asking whether the hunk would reverse out of it. Staging only.
 */
async function assertStillPending(
  runner: GitRunner,
  options: HunkStageOptions,
  patch: string,
  zeroContext: boolean
): Promise<void> {
  const { exitCode, stderr } = await runner.tryRun({
    args: ['apply', '--reverse', '--check', ...(zeroContext ? ['--unidiff-zero'] : []), '-'],
    cwd: options.worktreePath,
    stdin: patch,
    readOnly: true,
    timeoutMs: APPLY_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (exitCode === 0) return
  throw new GitServiceError(
    ErrorCode.Conflict,
    `${options.path} changed since that patch was read; look at it again and stage the hunk from what is there now.`,
    { stderr: stderr.trim() }
  )
}

function stale(staged: boolean, path: string, stderr: string): GitServiceError {
  return new GitServiceError(
    ErrorCode.Conflict,
    staged
      ? `that hunk no longer applies to ${path}; read the patch again.`
      : `that hunk is not in the index for ${path} any more; read the staged patch again.`,
    { stderr: stderr.trim() }
  )
}

/**
 * The minimal unified patch for one hunk: two path headers and the hunk. No `index`
 * line or mode; the header counts are recomputed from the lines (see `countLines`).
 */
export function hunkPatch(path: string, hunk: HunkInput): string {
  const counted = countLines(hunk)

  const body = hunk.lines
    .map((line) => {
      const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
      // After the line it is about, as git writes it; the only way the byte survives a round trip.
      return `${marker}${line.text}\n${line.noNewline === true ? '\\ No newline at end of file\n' : ''}`
    })
    .join('')

  const header = `@@ -${hunk.oldStart},${counted.old} +${hunk.newStart},${counted.new} @@\n`
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${header}${body}`
}

/**
 * The hunk's real line counts, and a refusal when the header disagrees. A patch cut
 * short at the byte ceiling still parses; `git apply --recount` would rewrite the
 * header to match and stage a truncation as though it were the change.
 */
function countLines(hunk: HunkInput): { old: number; new: number } {
  let oldSide = 0
  let newSide = 0
  for (const line of hunk.lines) {
    if (line.kind !== 'added') oldSide += 1
    if (line.kind !== 'removed') newSide += 1
  }
  if (oldSide !== hunk.oldCount || newSide !== hunk.newCount) {
    throw new GitServiceError(
      ErrorCode.InvalidParams,
      `that hunk is incomplete: its header says ${hunk.oldCount} and ${hunk.newCount} lines, and it carries ` +
        `${oldSide} and ${newSide}. A patch cut short at the byte ceiling cannot be staged a hunk at a time.`
    )
  }
  return { old: oldSide, new: newSide }
}

/**
 * A tab ends the file name on a `---`/`+++` line and a newline ends the line, so
 * either silently renames the file. Git C-quotes such a path; refusing is the honest half.
 */
export function assertCarriablePath(path: string): void {
  if (!/[\t\n\r]/.test(path)) return
  throw new GitServiceError(
    ErrorCode.InvalidParams,
    'a path with a tab or a newline in it cannot be named in a patch; stage that file whole.'
  )
}

/** Refuses the two kinds of path that have no hunk to stage. */
async function assertStageable(runner: GitRunner, options: HunkStageOptions): Promise<void> {
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', options.path],
    cwd: options.worktreePath,
    readOnly: true,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 30_000
  })
  const change = parseChangeRecords(stdout).find((entry) => entry.path === options.path)
  if (change === undefined) return

  if (change.kind === 'untracked') {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `${options.path} is untracked, so its whole content is the change; stage the file rather than a hunk of it.`
    )
  }
  if (change.kind === 'conflicted') {
    throw new GitServiceError(ErrorCode.Conflict, `resolve the conflict in ${options.path} first.`)
  }
}
