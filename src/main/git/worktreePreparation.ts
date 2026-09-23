// What a fresh checkout needs that git will not put there: ignored directories
// like `node_modules` are symlinked, ignored files like `.env` are copied.
// Everything here refuses out loud rather than leaving a checkout half prepared.

import { copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

/** Which list a path came from. It is in every refusal, so it is spelled once. */
type Kind = 'linked' | 'copied'

/**
 * What copying is allowed to cost, measured before a byte is written. Both halves
 * are needed: many tiny files pass any byte cap, one disk image passes any entry cap.
 */
export const COPY_BUDGET = { maxBytes: 16 * 1024 * 1024, maxEntries: 1_000 } as const

export type CopyBudget = { maxBytes: number; maxEntries: number }

export type PreparationOptions = {
  /** The primary checkout: where the real directories and files are. */
  repoPath: string
  /** The checkout `git worktree add` has just written. */
  worktreePath: string
  linkedPaths?: readonly string[]
  copiedPaths?: readonly string[]
  budget?: CopyBudget
  signal?: AbortSignal
}

/** What was actually put there, in the order it was put. */
export type Preparation = { linked: string[]; copied: string[] }

/** Cleans one configured path up, or says why it is not one: refused when typed, not at three in the morning. */
export function normalizePreparedPath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw refusal(ErrorCode.InvalidParams, 'a path must not be blank')
  if (trimmed.includes('\0')) throw refusal(ErrorCode.InvalidParams, `"${trimmed}" contains a null byte`)
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw refusal(ErrorCode.InvalidParams, `"${trimmed}" is absolute; name a path inside the repository`)
  }
  // `git ls-files` reads these as pathspecs, and a leading colon is pathspec magic.
  if (trimmed.startsWith(':')) {
    throw refusal(ErrorCode.InvalidParams, `"${trimmed}" starts with ":", which git reads as pathspec magic`)
  }

  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) throw refusal(ErrorCode.InvalidParams, `"${trimmed}" names no path`)
  if (segments.includes('..')) {
    throw refusal(ErrorCode.InvalidParams, `"${trimmed}" leaves the repository`)
  }
  return segments.join('/')
}

/** Normalizes a whole list, dropping repeats and keeping the order given. */
export function normalizePreparedPaths(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of raw) {
    const normalized = normalizePreparedPath(entry)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

/**
 * Links and copies what the project asked for. Every path is judged and the copy
 * list measured before the first symlink exists, so a refusal leaves the checkout untouched.
 */
export async function prepareWorktree(runner: GitRunner, options: PreparationOptions): Promise<Preparation> {
  const linked = normalizePreparedPaths(options.linkedPaths ?? [])
  const copied = normalizePreparedPaths(options.copiedPaths ?? [])
  if (linked.length === 0 && copied.length === 0) return { linked: [], copied: [] }

  for (const relative of linked) await judge(runner, options, relative, 'linked')
  for (const relative of copied) await judge(runner, options, relative, 'copied')
  await measureCopies(options, copied)

  for (const relative of linked) {
    const target = await claim(options, relative, 'linked')
    await symlink(path.join(options.repoPath, relative), target)
  }
  for (const relative of copied) {
    const target = await claim(options, relative, 'copied')
    await copyTree(path.join(options.repoPath, relative), target)
  }
  return { linked, copied }
}

/**
 * Whether this path may be carried over. Tracked is refused because a symlink
 * over it would have every task editing one tree; not-ignored because git would offer to commit it.
 */
async function judge(runner: GitRunner, options: PreparationOptions, relative: string, kind: Kind): Promise<void> {
  const source = path.join(options.repoPath, relative)
  const entry = await stat(source).catch(() => null)
  if (!entry) {
    throw refusal(ErrorCode.Conflict, `${kind} path "${relative}" is not in ${options.repoPath}`)
  }
  if (kind === 'linked' && !entry.isDirectory()) {
    throw refusal(ErrorCode.Conflict, `linked path "${relative}" is not a directory; link directories, copy files`)
  }

  const tracked = await runner.run({
    args: ['ls-files', '--cached', '-z', '--', relative],
    cwd: options.repoPath,
    readOnly: true,
    signal: options.signal,
    timeoutMs: 60_000
  })
  if (tracked.stdout.length > 0) {
    throw refusal(ErrorCode.Conflict, `${kind} path "${relative}" is tracked by git; the branch already carries it`)
  }

  // `check-ignore` and not our own reading of .gitignore: only git knows what
  // the repository, global excludes and .git/info/exclude add up to.
  const ignored = await runner.tryRun({
    args: ['check-ignore', '--quiet', '--', relative],
    cwd: options.repoPath,
    readOnly: true,
    signal: options.signal,
    timeoutMs: 60_000
  })
  if (ignored.exitCode === 1) {
    throw refusal(ErrorCode.Conflict, `${kind} path "${relative}" is not ignored by git`)
  }
  if (ignored.exitCode !== 0) {
    throw refusal(ErrorCode.Conflict, `git could not say whether "${relative}" is ignored`)
  }
}

/**
 * Walks the copy list, stopping the moment it is over budget: measuring
 * `node_modules` to the end would cost the minutes the budget prevents.
 */
async function measureCopies(options: PreparationOptions, copied: readonly string[]): Promise<void> {
  if (copied.length === 0) return
  const budget = options.budget ?? COPY_BUDGET
  const tally = { bytes: 0, entries: 0 }

  const walk = async (source: string, relative: string): Promise<void> => {
    const entry = await lstat(source)
    tally.entries += 1
    if (entry.isFile()) tally.bytes += entry.size
    if (tally.entries > budget.maxEntries) {
      throw refusal(
        ErrorCode.Conflict,
        `copied path "${relative}" holds more than ${budget.maxEntries} entries; link it instead of copying it`
      )
    }
    if (tally.bytes > budget.maxBytes) {
      throw refusal(
        ErrorCode.Conflict,
        `copied path "${relative}" is over the ${budget.maxBytes}-byte copy budget; link it instead of copying it`
      )
    }
    if (!entry.isDirectory()) return
    for (const child of await readdir(source)) await walk(path.join(source, child), relative)
  }

  for (const relative of copied) await walk(path.join(options.repoPath, relative), relative)
}

/** Makes room for one entry in the worktree, and refuses to write over anything. */
async function claim(options: PreparationOptions, relative: string, kind: Kind): Promise<string> {
  const target = path.join(options.worktreePath, relative)
  if (await lstat(target).catch(() => null)) {
    throw refusal(ErrorCode.Conflict, `${kind} path "${relative}" is already in the new worktree`)
  }
  await mkdir(path.dirname(target), { recursive: true })
  return target
}

/**
 * Copies a file, directory or symlink, following the shape of the walk that
 * measured it. A symlink is recreated rather than followed, as `cp -R` does.
 */
async function copyTree(source: string, target: string): Promise<void> {
  const entry = await lstat(source)
  if (entry.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  if (!entry.isDirectory()) {
    await copyFile(source, target)
    return
  }
  await mkdir(target, { recursive: true })
  for (const child of await readdir(source)) {
    await copyTree(path.join(source, child), path.join(target, child))
  }
}

function refusal(code: ErrorCode, message: string): GitServiceError {
  return new GitServiceError(code, message)
}

/** The two lists a project carries over, as every reader but preparation asks of them: together. */
export type PreparedPaths = {
  linkedPaths?: readonly string[]
  copiedPaths?: readonly string[]
}

/** Whether either list has anything in it. */
export function hasPreparedPaths(prepared: PreparedPaths | undefined): boolean {
  if (!prepared) return false
  return (prepared.linkedPaths?.length ?? 0) > 0 || (prepared.copiedPaths?.length ?? 0) > 0
}

/**
 * Whether a path in a worktree is one preparation put there. A linked path is
 * ours in any state: `node_modules/` matches directories only and a symlink is
 * not one, so git lists the link as untracked. A copied path is ours only until staged.
 */
export function isPreparedPath(prepared: PreparedPaths | undefined, entryPath: string, untracked: boolean): boolean {
  if (!prepared) return false
  if (covers(prepared.linkedPaths, entryPath)) return true
  return untracked && covers(prepared.copiedPaths, entryPath)
}

function covers(roots: readonly string[] | undefined, entryPath: string): boolean {
  if (!roots || roots.length === 0) return false
  const entry = tidyPath(entryPath)
  if (!entry) return false
  return roots.some((raw) => {
    const root = tidyPath(raw)
    return root.length > 0 && (entry === root || entry.startsWith(`${root}/`))
  })
}

/**
 * The comparable spelling of a path. Not `normalizePreparedPath`: this is asked
 * about paths git chose, and a comparison has nothing to refuse.
 */
function tidyPath(raw: string): string {
  return raw
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}
