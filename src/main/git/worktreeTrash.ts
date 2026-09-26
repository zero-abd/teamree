// Copies of uncommitted work taken before Remove or Discard throws it away: a commit whose tree is
// the working tree (untracked files included), kept under `refs/teamree/trash/` in the repository.

import { randomUUID } from 'node:crypto'
import { copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { RemovedWorktree, Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

export const TRASH_PREFIX = 'refs/teamree/trash/'

/** How long a copy is kept; older ones go on launch. */
export const TRASH_KEEP_MS = 14 * 24 * 60 * 60_000

const TIMEOUT_MS = 120_000

// Ours alone, so a machine with no git identity can still keep a copy.
const IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'teamree',
  GIT_AUTHOR_EMAIL: 'teamree@localhost',
  GIT_COMMITTER_NAME: 'teamree',
  GIT_COMMITTER_EMAIL: 'teamree@localhost'
}

/** The worktree record as the copy carries it: enough to put the row back. */
export type TrashedWorktree = Pick<
  Worktree,
  'id' | 'projectId' | 'name' | 'branch' | 'path' | 'startedFrom' | 'createdAt' | 'task' | 'parentId' | 'baseRef'
>

/** What the copy's message records. `index` is a commit whose tree is the index; `paths` limits a discard's copy. */
export type TrashNote = {
  kind: 'remove' | 'discard'
  worktree: TrashedWorktree
  head: string | null
  index: string | null
  paths?: string[]
}

export type TrashEntry = { id: string; sha: string; at: number; note: TrashNote }

/** `<worktree id>/<ms>`; checked before it goes near a ref name. */
export function isTrashId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}\/\d{1,16}$/.test(id)
}

/**
 * Writes the copy and its ref before anything is thrown away. With `paths`, only
 * those paths are taken from disk; the rest of the tree is the index.
 */
export async function snapshotWorktree(
  runner: GitRunner,
  options: {
    repoPath: string
    worktree: TrashedWorktree
    worktreePath: string
    kind: TrashNote['kind']
    paths?: readonly string[]
    now: number
  }
): Promise<TrashEntry> {
  const cwd = options.worktreePath
  const git = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
    (await runner.run({ args, cwd, timeoutMs: TIMEOUT_MS, ...(env === undefined ? {} : { env }) })).stdout.trim()

  const headRead = await runner.tryRun({ args: ['rev-parse', '--verify', '-q', 'HEAD'], cwd, readOnly: true })
  const head = headRead.exitCode === 0 ? headRead.stdout.trim() : null
  const parents = head === null ? [] : ['-p', head]

  // A conflicted index has no tree to write; the working tree is still copied.
  const indexTree = await runner.tryRun({ args: ['write-tree'], cwd, readOnly: true })
  const index =
    indexTree.exitCode === 0
      ? await git(['commit-tree', '--no-gpg-sign', indexTree.stdout.trim(), ...parents, '-m', 'index'], IDENTITY)
      : null

  // A private index beside the real one, seeded from it so unchanged files are not re-read.
  const gitDir = path.resolve(cwd, await git(['rev-parse', '--git-dir']))
  const realIndex = path.resolve(cwd, await git(['rev-parse', '--git-path', 'index']))
  const scratch = path.join(gitDir, `teamree-trash-${randomUUID()}.index`)
  let tree: string
  try {
    await copyFile(realIndex, scratch).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    const env = { GIT_INDEX_FILE: scratch }
    const pathspec = options.paths === undefined ? [] : ['--', ...options.paths]
    await git(['--literal-pathspecs', 'add', '-A', ...pathspec], env)
    tree = await git(['write-tree'], env)
  } finally {
    await rm(scratch, { force: true })
  }

  const note: TrashNote = {
    kind: options.kind,
    worktree: options.worktree,
    head,
    index,
    ...(options.paths === undefined ? {} : { paths: [...options.paths] })
  }
  // One line of JSON as the subject, so a listing reads every copy in one call.
  const sha = await git(
    [
      'commit-tree',
      '--no-gpg-sign',
      tree,
      ...parents,
      ...(index === null ? [] : ['-p', index]),
      '-m',
      JSON.stringify(note)
    ],
    IDENTITY
  )
  const id = `${options.worktree.id}/${options.now}`
  await runner.run({ args: ['update-ref', TRASH_PREFIX + id, sha], cwd: options.repoPath, timeoutMs: TIMEOUT_MS })
  return { id, sha, at: options.now, note }
}

/** Every copy in the repository, newest first; one whose message is not ours is left out. */
export async function listTrash(runner: GitRunner, repoPath: string): Promise<TrashEntry[]> {
  const { stdout } = await runner.run({
    args: ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(contents:subject)', TRASH_PREFIX],
    cwd: repoPath,
    readOnly: true,
    timeoutMs: TIMEOUT_MS
  })
  const entries: TrashEntry[] = []
  for (const line of stdout.split('\n')) {
    const [ref, sha, subject] = line.split('\t')
    if (ref === undefined || sha === undefined || subject === undefined) continue
    const id = ref.slice(TRASH_PREFIX.length)
    const note = parseNote(subject)
    if (!isTrashId(id) || note === null) continue
    entries.push({ id, sha, at: Number(id.split('/')[1]), note })
  }
  return entries.sort((a, b) => b.at - a.at)
}

export async function readTrash(runner: GitRunner, repoPath: string, id: string): Promise<TrashEntry> {
  if (!isTrashId(id)) throw new GitServiceError(ErrorCode.InvalidParams, `"${id}" names no kept copy`)
  const entry = (await listTrash(runner, repoPath)).find((candidate) => candidate.id === id)
  if (entry === undefined) throw new GitServiceError(ErrorCode.NotFound, 'that copy is gone')
  return entry
}

export async function dropTrash(runner: GitRunner, repoPath: string, id: string): Promise<void> {
  if (!isTrashId(id)) return
  await runner.tryRun({ args: ['update-ref', '-d', TRASH_PREFIX + id], cwd: repoPath, timeoutMs: TIMEOUT_MS })
}

/** Drops copies older than `keepMs`; returns how many went. */
export async function pruneTrash(
  runner: GitRunner,
  repoPath: string,
  now: number,
  keepMs = TRASH_KEEP_MS
): Promise<number> {
  const stale = (await listTrash(runner, repoPath)).filter((entry) => now - entry.at > keepMs)
  for (const entry of stale) await dropTrash(runner, repoPath, entry.id)
  return stale.length
}

/**
 * Writes the copy's files into a checkout: every path, or `paths`. The index is
 * put back too when `withIndex`, which only a fresh checkout wants.
 */
export async function restoreTrash(
  runner: GitRunner,
  options: { worktreePath: string; entry: TrashEntry; paths?: readonly string[]; withIndex?: boolean }
): Promise<void> {
  const cwd = options.worktreePath
  const run = (args: string[]): Promise<unknown> => runner.run({ args, cwd, timeoutMs: TIMEOUT_MS })
  const paths = options.paths ?? ['.']
  await run(['--literal-pathspecs', 'restore', `--source=${options.entry.sha}`, '--worktree', '--', ...paths])
  const index = options.entry.note.index
  if (options.withIndex === true && index !== null) {
    await run(['read-tree', `${index}^{tree}`])
    await runner.tryRun({ args: ['update-index', '-q', '--refresh'], cwd, timeoutMs: TIMEOUT_MS })
  }
}

/** As listed: under the project whose repository holds it, which outlives a project id. */
export function removedWorktree(entry: TrashEntry, projectId: string): RemovedWorktree {
  const worktree = entry.note.worktree
  return {
    id: entry.id,
    projectId,
    worktreeId: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    ...(worktree.task === undefined ? {} : { task: worktree.task }),
    removedAt: entry.at
  }
}

function parseNote(subject: string): TrashNote | null {
  try {
    const note = JSON.parse(subject) as Partial<TrashNote>
    const worktree = note.worktree
    if (note.kind !== 'remove' && note.kind !== 'discard') return null
    if (typeof worktree?.id !== 'string' || typeof worktree.branch !== 'string' || typeof worktree.path !== 'string') {
      return null
    }
    return note as TrashNote
  } catch {
    return null
  }
}
