// One commit and its patch, read-only: what `git show` prints, against the first parent.

import type { WorktreeCommitPatch } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { cutToBytes, DEFAULT_DIFF_CONTEXT_LINES, DEFAULT_DIFF_MAX_BYTES } from './worktreeChanges'
import { parseLogRecords } from './worktreeLog'

/** An abbreviated or full object name; never a ref or anything git could read as an option. */
const OBJECT_NAME = /^[0-9a-f]{4,64}$/i

/** Room for the header fields ahead of the patch in the same read. */
const HEADER_ALLOWANCE_BYTES = 16 * 1024

export type CommitReadOptions = {
  worktreeId: string
  worktreePath: string
  sha: string
  contextLines?: number
  maxBytes?: number
  signal?: AbortSignal
  now?: () => number
}

export async function readCommit(runner: GitRunner, options: CommitReadOptions): Promise<WorktreeCommitPatch> {
  if (!OBJECT_NAME.test(options.sha)) {
    throw new GitServiceError(ErrorCode.InvalidParams, `"${options.sha}" is not a commit id`)
  }
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_BYTES
  const result = await runner.tryRun({
    args: [
      'show',
      '--no-color',
      '--no-ext-diff',
      // A merge's combined diff is a format the viewer does not read.
      '-m',
      '--first-parent',
      `--unified=${options.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES}`,
      '--format=%H%x00%an%x00%aI%x00%s%x00',
      `${options.sha}^{commit}`,
      '--'
    ],
    cwd: options.worktreePath,
    readOnly: true,
    stdoutLimitBytes: maxBytes + HEADER_ALLOWANCE_BYTES,
    timeoutMs: 60_000,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (result.exitCode !== 0 && result.stdoutClipped !== true) {
    throw new GitServiceError(ErrorCode.NotFound, `commit ${options.sha} is not in this repository`)
  }

  const [summary] = parseLogRecords(result.stdout)
  if (summary === undefined) {
    throw new GitServiceError(ErrorCode.GitFailed, `git show ${options.sha} printed no commit`)
  }
  let cut = 0
  for (let field = 0; field < 4; field += 1) cut = result.stdout.indexOf('\0', cut) + 1
  const patch = result.stdout.slice(cut).replace(/^\n+/, '')
  const truncated = result.stdoutClipped === true || Buffer.byteLength(patch, 'utf8') > maxBytes
  return {
    worktreeId: options.worktreeId,
    ...summary,
    patch: truncated ? cutToBytes(patch, maxBytes) : patch,
    truncated,
    readAt: (options.now ?? Date.now)()
  }
}
