// Clear Lock: an `index.lock` left by a killed git blocks every write in its checkout until it is
// removed. It is removed only when no git process runs there and it has been left a while.

import { execFile } from 'node:child_process'
import { readFile, readlink, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { WorktreeLock } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

/** A lock younger than this may belong to a git that is still starting or finishing. */
export const STALE_LOCK_MS = 5_000

export type GitProcess = { pid: number; cwd: string | null; args: string }

/** Every git process on the machine; null when they cannot be listed, which counts as one running. */
export type GitProcesses = () => Promise<GitProcess[] | null>

export type IndexLockOptions = {
  worktreePath: string
  lockPath: string
  gitProcesses?: GitProcesses
  now?: () => number
}

export async function readIndexLock(runner: GitRunner, options: IndexLockOptions): Promise<WorktreeLock> {
  return (await judge(runner, options)).lock
}

export async function clearIndexLock(runner: GitRunner, options: IndexLockOptions): Promise<WorktreeLock> {
  const { lock, ino } = await judge(runner, options)
  if (!lock.exists) return lock
  if (lock.gitRunning) throw new GitServiceError(ErrorCode.Conflict, 'A git process is running in this checkout')
  if (!lock.clearable) throw new GitServiceError(ErrorCode.Conflict, 'The lock is still fresh')
  // Gone and taken again since it was judged: that one belongs to a git that is running now.
  if ((await stat(lock.lockPath).catch(() => null))?.ino !== ino) return { ...lock, clearable: false }
  await unlink(lock.lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  return { ...lock, exists: false, clearable: false }
}

async function judge(runner: GitRunner, options: IndexLockOptions): Promise<{ lock: WorktreeLock; ino?: number }> {
  const { lockPath, checkout } = await locate(runner, options)
  const stats = await stat(lockPath).catch(() => null)
  const running = await (options.gitProcesses ?? listGitProcesses)()
  const gitRunning = running === null || running.some((each) => runsIn(each, checkout))
  const ageMs = stats === null ? 0 : Math.max(0, (options.now ?? Date.now)() - stats.mtimeMs)
  const exists = stats !== null
  const lock = { lockPath, exists, ageMs, gitRunning, clearable: exists && !gitRunning && ageMs >= STALE_LOCK_MS }
  return stats === null ? { lock } : { lock, ino: stats.ino }
}

/** The lock, if it is `index.lock` of this repository's main checkout or one of its worktrees, and that checkout. */
async function locate(runner: GitRunner, options: IndexLockOptions): Promise<{ lockPath: string; checkout: string }> {
  const { stdout } = await runner.run({
    args: ['rev-parse', '--git-common-dir'],
    cwd: options.worktreePath,
    readOnly: true
  })
  const common = await realpath(path.resolve(options.worktreePath, stdout.trim()))
  const refused = new GitServiceError(ErrorCode.InvalidParams, `${options.lockPath} is not an index lock here`)
  if (path.basename(options.lockPath) !== 'index.lock') throw refused
  const dir = await realpath(path.dirname(options.lockPath)).catch(() => {
    throw refused
  })
  const lockPath = path.join(dir, 'index.lock')
  if (dir === common) {
    return { lockPath, checkout: path.basename(common) === '.git' ? path.dirname(common) : common }
  }
  if (path.dirname(dir) !== path.join(common, 'worktrees')) throw refused
  // A linked worktree's admin folder names its checkout's `.git` file.
  const gitFile = await readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => null)
  const checkout = gitFile === null ? dir : path.dirname(gitFile.trim())
  return { lockPath, checkout: await realpath(checkout).catch(() => checkout) }
}

function runsIn(process: GitProcess, checkout: string): boolean {
  const inside = (at: string): boolean => at === checkout || at.startsWith(checkout + path.sep)
  return process.cwd === null || inside(process.cwd) || process.args.includes(checkout)
}

/** Processes whose program is git, with their working directories, via `ps` and `lsof` (macOS) or `/proc` (Linux). */
export async function listGitProcesses(): Promise<GitProcess[] | null> {
  if (process.platform === 'win32') return null
  const listed = await run('ps', ['-axo', 'pid=,args='])
  if (listed === null) return null
  const git = listed
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), args: match[2] ?? '' }))
    .filter((each) => path.basename(each.args.split(' ')[0] ?? '') === 'git')
  if (git.length === 0) return []
  const cwds = await workingDirectories(git.map((each) => each.pid))
  return git.map((each) => ({ ...each, cwd: cwds.get(each.pid) ?? null }))
}

async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null)
        if (cwd !== null) cwds.set(pid, cwd)
      })
    )
    return cwds
  }
  // `-F pn`: a `p<pid>` line, then an `n<path>` line for its cwd.
  const listed = await run('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')])
  let pid = 0
  for (const line of (listed ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** stdout, also of a non-zero exit (lsof exits 1 when one pid has gone); null when the program could not run. */
function run(program: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const exited = error === null || typeof (error as NodeJS.ErrnoException).code === 'number'
      resolve(exited ? stdout : null)
    })
  })
}
