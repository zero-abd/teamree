// What a fresh checkout needs that git will not put there.
//
// `git worktree add` writes the tracked files and stops, which is correct and
// is also why minute three of a first session is an agent running `npm test`
// against a directory with no `node_modules` and no `.env`. Those files are
// ignored, so they are not in the branch, so they are nowhere.
//
// Two lists, because the two kinds of missing file want opposite things.
// A directory like `node_modules` or `.venv` is large and rebuildable, and
// every worktree of a repo wants the same one: it is symlinked, never copied,
// so five worktrees cost one install. A file like `.env` is small and is
// exactly the thing a task might need to change: it is copied, so the worktrees
// can diverge and a debugging session cannot edit the primary checkout's secret
// by accident.
//
// One thing to know about the link, because git decides it and we do not: an
// ignore rule written with a trailing slash — `node_modules/`, which is how
// most repositories write it — matches directories only, and a symlink is not a
// directory. So in the new checkout that link is an untracked file rather than
// an ignored one: `git status` lists it, and an unforced `worktree remove`
// refuses over it as a dirty checkout instead of naming it as an ignored entry.
// Both are refusals and nothing is destroyed either way — git unlinks the
// symlink and never walks through it — but the sentence differs, which is why
// `worktreePreparation.test.ts` pins both spellings.
//
// Everything here refuses out loud. A path that is tracked, missing, or not
// ignored is named in the error with the reason, because the alternative —
// skipping it quietly — produces a worktree that looks prepared and is not,
// which is the failure this whole file exists to remove.

import { copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

/** Which list a path came from. It is in every refusal, so it is spelled once. */
type Kind = 'linked' | 'copied'

/**
 * What copying is allowed to cost, measured before a byte is written.
 *
 * The budget is the difference between `node_modules` under the copy list
 * being a refusal and being a four-minute freeze on a background task nobody
 * can see. Both halves are needed: a directory of many tiny files passes any
 * byte cap, and one disk image passes any entry cap.
 *
 * The numbers are sized for what this list is for — dotfiles holding
 * credentials and local overrides — with room for a fixture database, and not
 * for anything a package manager produced.
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

/**
 * Cleans one configured path up, or says why it is not one.
 *
 * Relative and inside the repository, both checked here rather than at the
 * moment of use: a setting that names `/etc` or `../../` is wrong when it is
 * typed, and refusing it then is the difference between a message beside the
 * field and a worktree that fails to create at three in the morning.
 */
export function normalizePreparedPath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw refusal(ErrorCode.InvalidParams, 'a path must not be blank')
  if (trimmed.includes('\0')) throw refusal(ErrorCode.InvalidParams, `"${trimmed}" contains a null byte`)
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw refusal(ErrorCode.InvalidParams, `"${trimmed}" is absolute; name a path inside the repository`)
  }
  // Pathspec magic is how a path stops meaning a path. `git ls-files` reads
  // these arguments as pathspecs, and a leading colon would let a setting say
  // something other than what it appears to say.
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
 * Links and copies what the project asked for, and refuses before writing.
 *
 * Every path is judged first — shape, existence, tracked, ignored — and the
 * copy list is then measured against the budget, all before the first symlink
 * exists. A refusal therefore leaves the checkout exactly as `git worktree add`
 * left it, rather than half prepared, which is the state nothing downstream
 * could describe.
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
 * Whether this path may be carried over at all.
 *
 * Tracked is refused because git has already put the branch's own copy there,
 * and a symlink over it would point a worktree's source at the primary
 * checkout — every task editing one tree. Not-ignored is refused for the
 * neighbouring reason: a path git would offer to commit is a path this feature
 * has no business duplicating behind git's back.
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

  // `check-ignore` and not our own reading of .gitignore: the rules compose
  // across the repository, the user's global excludes and .git/info/exclude,
  // and only git knows what they add up to.
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
 * Walks the copy list, stopping the moment it is over budget.
 *
 * Stopping early is the point rather than an optimization: measuring
 * `node_modules` to the end so as to report its true size would cost the same
 * minutes the budget exists to prevent.
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
 * Copies a file, a directory, or a symlink, following the shape of the walk
 * that measured it — so what lands is what was counted.
 *
 * A symlink is recreated rather than followed, the way `cp -R` does it: a
 * config directory holding a link to somewhere else keeps meaning what it said.
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
