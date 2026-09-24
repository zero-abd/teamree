// Remove and Discard keep a copy first, in the repository's own refs, and the copy puts the work back.

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { parsePatch } from '../../shared/patch'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'
import type { Trash } from './worktreeDiscard'
import { listTrash, TRASH_KEEP_MS, TRASH_PREFIX } from './worktreeTrash'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function setUp(options: { runner?: GitRunner; now?: () => number; trash?: Trash } = {}): Promise<{
  repo: TempRepo
  service: GitService
  projectId: string
  worktree: Worktree
}> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('src/math.ts', 'export const add = (a, b) => a + b\n')
  await repo.commit('add math')
  const service = new GitService({
    worktreesRoot: repo.worktreesRoot,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.trash === undefined ? {} : { trash: options.trash })
  })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const pending = await service.createWorktree({ projectId: project.id, name: 'add sub codex' })
  const worktree = await service.whenSettled(pending.id)
  if (worktree.state !== 'ready') throw new Error(worktree.error)
  return { repo, service, projectId: project.id, worktree }
}

const read = (worktree: Worktree, file: string): Promise<string> => readFile(path.join(worktree.path, file), 'utf8')

describe('removing keeps a copy', () => {
  it('restores the checkout on its branch with modified and untracked files back', async () => {
    const { repo, service, projectId, worktree } = await setUp()
    await writeFile(path.join(worktree.path, 'src/math.ts'), 'export const sub = (a, b) => a - b\n')
    await writeFile(path.join(worktree.path, 'notes.md'), 'untracked\n')

    const removed = await service.removeWorktree({ worktreeId: worktree.id, force: true })

    expect(removed.trashId).toBeDefined()
    expect(existsSync(worktree.path)).toBe(false)
    // In the repository's refs, nowhere in anybody's working tree.
    expect(await repo.git(['for-each-ref', '--format=%(refname)', TRASH_PREFIX])).toBe(
      `${TRASH_PREFIX}${removed.trashId}`
    )
    const listed = await service.listRemovedWorktrees({ projectId })
    expect(listed).toMatchObject([{ id: removed.trashId, worktreeId: worktree.id, name: 'add sub codex' }])

    const restored = await service.restoreWorktree({ projectId, removedId: removed.trashId as string })

    expect(restored).toMatchObject({ id: worktree.id, branch: worktree.branch, path: worktree.path, state: 'ready' })
    expect(await read(worktree, 'src/math.ts')).toBe('export const sub = (a, b) => a - b\n')
    expect(await read(worktree, 'notes.md')).toBe('untracked\n')
    expect(await repo.git(['status', '--porcelain'], worktree.path)).toBe('M src/math.ts\n?? notes.md')
    expect(await repo.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path)).toBe(worktree.branch)
    expect(await service.listRemovedWorktrees({ projectId })).toEqual([])
    expect(service.snapshot().worktrees.map((entry) => entry.id)).toContain(worktree.id)
  })

  it('brings back a branch deleted with the checkout, and what was staged', async () => {
    const { repo, service, projectId, worktree } = await setUp()
    await writeFile(path.join(worktree.path, 'staged.txt'), 'staged\n')
    await repo.git(['add', 'staged.txt'], worktree.path)

    const removed = await service.removeWorktree({ worktreeId: worktree.id, force: true, deleteBranch: true })
    expect(await repo.git(['branch', '--list', worktree.branch])).toBe('')

    await service.restoreWorktree({ projectId, removedId: removed.trashId as string })

    expect(await repo.git(['status', '--porcelain'], worktree.path)).toBe('A  staged.txt')
  })

  it('removes nothing when the copy cannot be written', async () => {
    const real = createGitRunner()
    const refusing: GitRunner = {
      binary: real.binary,
      tryRun: (run) => real.tryRun(run),
      run: (run) => (run.args[0] === 'update-ref' ? Promise.reject(new Error('disk full')) : real.run(run))
    }
    const { service, worktree } = await setUp({ runner: refusing })
    await writeFile(path.join(worktree.path, 'notes.md'), 'untracked\n')

    const refusal = await service.removeWorktree({ worktreeId: worktree.id, force: true }).catch((error) => error)

    expect(refusal).toBeInstanceOf(GitServiceError)
    expect((refusal as GitServiceError).code).toBe(ErrorCode.Conflict)
    expect((refusal as Error).message).toMatch(/^could not keep a copy first, so nothing was removed/)
    expect(await read(worktree, 'notes.md')).toBe('untracked\n')
    expect(service.snapshot().worktrees.find((entry) => entry.id === worktree.id)?.state).toBe('ready')
  })

  it('prunes copies older than a fortnight', async () => {
    let now = 1_000_000
    const { repo, service, worktree } = await setUp({ now: () => now })
    await service.removeWorktree({ worktreeId: worktree.id, force: true })

    now += TRASH_KEEP_MS + 1
    expect(await service.pruneTrash()).toBe(1)
    expect(await listTrash(repo.runner, repo.repoPath)).toEqual([])
  })
})

describe('discarding keeps a copy', () => {
  const hunkOf = async (repo: TempRepo, cwd: string) =>
    parsePatch(`${await repo.git(['diff', '--no-color'], cwd)}\n`)[0]?.hunks[0]

  it('puts a discarded hunk back exactly', async () => {
    const { repo, service, worktree } = await setUp()
    await writeFile(path.join(worktree.path, 'src/math.ts'), 'export const add = (a, b) => a + b + 0\n')
    const before = await repo.git(['diff', '--no-color'], worktree.path)
    const hunk = await hunkOf(repo, worktree.path)

    const discarded = await service.worktreeDiscardHunk({
      worktreeId: worktree.id,
      path: 'src/math.ts',
      hunk: hunk as NonNullable<typeof hunk>
    })
    expect(await repo.git(['diff', '--no-color'], worktree.path)).toBe('')

    await service.undoDiscard({ worktreeId: worktree.id, trashId: discarded.trashId as string })

    expect(await repo.git(['diff', '--no-color'], worktree.path)).toBe(before)
    expect(await listTrash(repo.runner, repo.repoPath)).toEqual([])
  })

  it('puts a discarded untracked file back from its copy', async () => {
    const trashed: string[] = []
    const { service, worktree } = await setUp({
      trash: async (absolute) => {
        trashed.push(absolute)
        await rm(absolute)
      }
    })
    await writeFile(path.join(worktree.path, 'notes.md'), 'untracked\n')

    const discarded = await service.worktreeDiscardPath({ worktreeId: worktree.id, path: 'notes.md' })
    expect(trashed).toEqual([path.join(worktree.path, 'notes.md')])

    await service.undoDiscard({ worktreeId: worktree.id, trashId: discarded.trashId as string })
    expect(await read(worktree, 'notes.md')).toBe('untracked\n')
  })
})
