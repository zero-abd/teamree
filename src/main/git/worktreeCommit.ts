// Committing from inside the app: the first thing here that writes to a
// repository, so it refuses rather than guesses. Nothing is staged unasked; `all` asks for
// everything. A conflicted tree, an empty commit and a git with no identity are refused.

import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GitHookFailedData, WorktreeCommit } from '../../shared/entities'
import { GitCommandError, GitServiceError } from './errors'
import type { GitOutput, GitRunner } from './gitProcess'
import { ErrorCode } from '../../shared/protocol'
import { parseChangeRecords } from './worktreeChanges'
import { preparedExcludes, type PreparedPaths } from './worktreePreparation'

/** Hooks run, and a hook can be slow; this is the ceiling before one is killed. */
const COMMIT_TIMEOUT_MS = 120_000
/** How much of a refusing hook's output is kept. */
const HOOK_OUTPUT_LINES = 200

export type CommitOptions = {
  worktreeId: string
  worktreePath: string
  message: string
  /** Paths to stage before committing. Omitted means commit what is already staged. */
  paths?: readonly string[]
  /** Stage every change first (`git add -A`), however many; never with `paths`. */
  all?: boolean
  /** Rewrite the last commit instead of adding one; with nothing staged, only its message. */
  amend?: boolean
  /** Left out of `all`: what the project put in the checkout is not a change. */
  prepared?: PreparedPaths
  signal?: AbortSignal
  now?: () => number
}

export async function commitWorktree(runner: GitRunner, options: CommitOptions): Promise<WorktreeCommit> {
  const message = options.message.trim()
  if (message.length === 0) {
    throw new GitServiceError(ErrorCode.InvalidParams, 'a commit needs a message')
  }
  if (options.all === true && options.paths !== undefined) {
    throw new GitServiceError(ErrorCode.InvalidParams, 'name paths or commit all, not both')
  }

  const run = { cwd: options.worktreePath, timeoutMs: COMMIT_TIMEOUT_MS } as const
  const signal = options.signal ? { signal: options.signal } : {}

  await requireCommitIdentity(runner, options.worktreePath, options.signal)

  const before = await readStatus(runner, options.worktreePath, options.signal)
  const conflicted = before.filter((change) => change.kind === 'conflicted').map((change) => change.path)
  if (conflicted.length > 0) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `resolve the conflict${conflicted.length === 1 ? '' : 's'} first: ${conflicted.join(', ')}`
    )
  }

  if (options.all === true) {
    const excludes = await preparedExcludes(runner, options.worktreePath, options.prepared, options.signal)
    await runner.run({ args: ['add', '-A', '--', '.', ...excludes], ...run, ...signal })
  } else if (options.paths && options.paths.length > 0) {
    // `--` first, so a path that looks like a flag or a ref is still a path.
    await runner.run({ args: ['add', '--', ...options.paths], ...run, ...signal })
  }

  const staged = (await readStatus(runner, options.worktreePath, options.signal)).filter((change) => change.staged)
  if (staged.length === 0 && options.amend !== true) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      options.all === true
        ? 'nothing to commit'
        : options.paths && options.paths.length > 0
          ? 'those paths have nothing staged to commit'
          : 'nothing is staged; name the paths to commit, or stage them first'
    )
  }

  const args = ['commit', ...(options.amend === true ? ['--amend'] : []), '-m', message]
  // git's trace names the hook that exited non-zero; its prose says nothing a hook could not also print.
  const trace = path.join(os.tmpdir(), `teamree-commit-${randomUUID()}.trace`)
  try {
    const output = await runner.tryRun({ args, ...run, ...signal, env: { GIT_TRACE2_EVENT: trace } })
    if (output.exitCode !== 0) {
      const hook = await refusingHook(trace)
      if (hook !== null) throw hookFailure(hook, output)
      throw new GitCommandError({ args, cwd: run.cwd, exitCode: output.exitCode, stderr: output.stderr })
    }
  } finally {
    await rm(trace, { force: true })
  }

  const { stdout } = await runner.run({
    args: ['rev-parse', 'HEAD'],
    cwd: options.worktreePath,
    readOnly: true,
    ...signal
  })
  const sha = stdout.trim()

  return {
    worktreeId: options.worktreeId,
    sha,
    shortSha: sha.slice(0, 7),
    message,
    // What this commit actually captured: a path already staged from an earlier
    // edit goes in too.
    paths: staged.map((change) => change.path).sort(),
    committedAt: (options.now ?? Date.now)()
  }
}

/**
 * Refuses before anything is staged when git has no identity. Otherwise the
 * commit fails at the last step with "Author identity unknown", after staging and
 * a typed message. `git var` resolves the ident exactly as `commit` does, so this
 * cannot disagree with it. Never sets one: whose name a commit carries is the user's to say.
 */
export async function requireCommitIdentity(
  runner: GitRunner,
  worktreePath: string,
  signal?: AbortSignal
): Promise<void> {
  const { exitCode } = await runner.tryRun({
    args: ['var', 'GIT_AUTHOR_IDENT'],
    cwd: worktreePath,
    readOnly: true,
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  if (exitCode === 0) return

  throw new GitServiceError(
    ErrorCode.Conflict,
    'git does not know who you are, so it will not write a commit. Set a name and an email once, ' +
      'in a terminal: git config --global user.name "Your Name" and ' +
      'git config --global user.email "you@example.com".'
  )
}

async function readStatus(
  runner: GitRunner,
  worktreePath: string,
  signal?: AbortSignal
): Promise<ReturnType<typeof parseChangeRecords>> {
  // `--untracked-files=normal` is pinned: `status.showUntrackedFiles=no` in
  // ~/.gitconfig would otherwise answer "nothing untracked" for a checkout whose
  // status chip, which pins the flag, says otherwise.
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=normal'],
    cwd: worktreePath,
    readOnly: true,
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  return parseChangeRecords(stdout)
}

/** The hook that failed this commit according to git's own trace, or null when none did. */
async function refusingHook(trace: string): Promise<string | null> {
  const text = await readFile(trace, 'utf8').catch(() => '')
  const hooks = new Map<number, string>()
  let failed: string | null = null
  for (const line of text.split('\n')) {
    let event: {
      event?: string
      sid?: string
      child_id?: number
      child_class?: string
      hook_name?: string
      code?: number
    }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    // A git run by the hook traces into the same file under a nested sid.
    if (event.sid?.includes('/') !== false || event.child_id === undefined) continue
    if (event.event === 'child_start' && event.child_class === 'hook' && event.hook_name) {
      hooks.set(event.child_id, event.hook_name)
    } else if (event.event === 'child_exit' && event.code !== 0 && hooks.has(event.child_id)) {
      failed = hooks.get(event.child_id) ?? null
    }
  }
  return failed
}

function hookFailure(hook: string, output: GitOutput): GitServiceError {
  const lines = [output.stdout, output.stderr]
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  const kept = lines.slice(0, HOOK_OUTPUT_LINES)
  const left = lines.length - kept.length
  const text = [...kept, ...(left > 0 ? [`… ${left} more lines`] : [])].join('\n')
  const first = lines.find((line) => line.trim() !== '')
  return new GitServiceError(
    ErrorCode.GitFailed,
    first === undefined ? `${hook} hook failed` : `${hook} hook failed: ${first.trim()}`,
    { kind: 'hook', hook, output: text } satisfies GitHookFailedData
  )
}
