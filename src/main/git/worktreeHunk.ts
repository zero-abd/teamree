// Staging one hunk, which is the second thing here that writes to a repository.
//
// Everything about it is the inverse of reading a patch. `worktreeChanges` asks
// git what changed and renders the answer; this takes a piece of that answer
// back and asks git to make it true of the index. So it is built the way
// `worktreeCommit` is — to refuse rather than to guess — and the refusals are
// the interesting part of the file.
//
// The index and only the index. `--cached` is not an optimisation: the working
// tree is what the person is editing, and a tool that rewrites the file under
// an open editor to stage part of it has damaged something it was never asked
// to touch. Staging is a statement about what the next commit contains, and the
// index is where that statement lives.
//
// Four refusals shape it:
//
//   - A path git is not tracking, or one with a conflict in it, is refused
//     before a patch is even built. An untracked file's whole content is one
//     hunk by construction — there is nothing on the other side to diff it
//     against — so "stage this hunk" and "stage this file" are the same act,
//     and the file list already does the second one honestly.
//   - A hunk whose lines do not add up to its own header is refused. The patch
//     a caller was shown may have been cut short at `readWorktreeDiff`'s byte
//     ceiling, and half a hunk still parses: `parsePatch` is deliberately
//     tolerant of that. Applying half of one would stage a truncation.
//   - A hunk that no longer describes the index is refused, which is git's own
//     judgement through `--check`.
//   - A hunk that no longer describes the working tree is refused, which is the
//     one that actually matters and the one `--cached` alone will not make.
//     See `assertStillPending` below.

import type { WorktreeHunkStage } from '../../shared/entities'
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
  // Zero context is the one shape `git apply` refuses to place on its own: with
  // no surrounding lines there is nothing to match, so it wants to be told that
  // the emptiness is deliberate rather than a patch that lost its context.
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

  // Asked before it is done, so the failure arrives with nothing half-applied
  // behind it. A hunk is one atom to git, so this is belt and braces — but the
  // message a `--check` produces is the one worth putting in front of somebody,
  // and it costs a process nobody is waiting on.
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

/**
 * The check `--cached` cannot make, and the reason staging a hunk is not simply
 * "run git apply".
 *
 * `git apply --cached` compares the hunk's old side against the index. The
 * index is the one thing in this picture that nobody has been editing, so that
 * check passes for a hunk read ten minutes and four saves ago — and the patch
 * it then writes into the index is a version of the file that is no longer
 * anywhere on disk. The user clicked "Stage" on a hunk they were looking at and
 * got a different one.
 *
 * So the new side is checked too, against the working tree, by asking git
 * whether the hunk would reverse out of it. It would exactly when the change is
 * still sitting there unstaged, which is the condition being claimed. Nothing
 * is written: `--check` on its own is a question.
 *
 * Only for staging. Unstaging's two sides are the index and HEAD, and the index
 * side is already what `--reverse --cached --check` tests; HEAD is not a thing
 * a patch can be checked against without writing one out.
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
 * The minimal unified patch for one hunk: two path headers and the hunk.
 *
 * No `index` line and no mode: neither is needed to apply, and both would be a
 * claim about blobs this never read. The counts in the header are recomputed
 * from the lines rather than copied from the caller — see `countLines` — and
 * then checked against what the caller said they were.
 */
export function hunkPatch(path: string, hunk: HunkInput): string {
  const counted = countLines(hunk)

  const body = hunk.lines
    .map((line) => {
      const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
      // The remark belongs after the line it is about, which is how git writes
      // it and the only way the byte it describes survives a round trip.
      return `${marker}${line.text}\n${line.noNewline === true ? '\\ No newline at end of file\n' : ''}`
    })
    .join('')

  const header = `@@ -${hunk.oldStart},${counted.old} +${hunk.newStart},${counted.new} @@\n`
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${header}${body}`
}

/**
 * What the hunk's lines actually come to on each side, and a refusal when that
 * is not what its header claims.
 *
 * A patch read through `worktree.diff` can be cut short at a byte ceiling, and
 * the parser hands back the part that arrived rather than failing — which is
 * right for a reader and fatal for a writer. A hunk missing its last four lines
 * has a header promising them, and `git apply --recount` would cheerfully paper
 * over that by rewriting the header to match: the patch applies, and it stages
 * a truncation as though it were the change.
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
 * Paths the unified format cannot carry unquoted, which is two characters.
 *
 * A tab ends the file name on a `---`/`+++` line and a newline ends the line,
 * so either one silently renames the file the patch is about. Git quotes such
 * a path C-style when it writes one; refusing is the honest half of that,
 * because a path with a tab in it is not something this app has to support and
 * quietly staging a hunk against the wrong file is not an option.
 */
function assertCarriablePath(path: string): void {
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
