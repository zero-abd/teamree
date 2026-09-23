// What a new checkout is given, and everything it is refused.
//
// Driven against real repositories and a real filesystem, like the rest of this
// folder: the whole subject is what git considers tracked, what it considers
// ignored, and what the filesystem does with a symlink, and mocking any of the
// three would only prove our idea of them is self-consistent.

import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService, type GitServiceOptions } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'
import { normalizePreparedPath, prepareWorktree, type CopyBudget } from './worktreePreparation'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/**
 * A repository shaped like the one this feature is for: a tracked source file,
 * an installed dependency directory, and a secret — the last two ignored, which
 * is exactly why `git worktree add` leaves both behind.
 */
async function fixture(): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  // Two spellings of an ignore rule on purpose. `node_modules/` matches only a
  // directory, and a symlink is not one — see the removal tests at the foot of
  // this file, where the difference decides which refusal a removal gives.
  await repo.write('.gitignore', 'node_modules/\n.venv\n.env\n.cache/\nvendor.bin\n')
  await repo.write('src/index.ts', 'export const answer = 42\n')
  await repo.commit('a repository with things to ignore')
  await repo.write('node_modules/left-pad/index.js', 'module.exports = () => {}\n')
  await repo.write('.venv/lib/site.py', 'import sys\n')
  await repo.write('.env', 'TOKEN=hunter2\n')
  return repo
}

/** A checkout made the way the service makes one, without the service. */
async function checkout(repo: TempRepo, name = 'task'): Promise<string> {
  const worktreePath = path.join(repo.worktreesRoot, name)
  await mkdir(repo.worktreesRoot, { recursive: true })
  await repo.git(['worktree', 'add', '-b', name, worktreePath, 'HEAD'])
  return worktreePath
}

async function refusal(promise: Promise<unknown>): Promise<GitServiceError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GitServiceError)
    return error as GitServiceError
  }
  throw new Error('expected the preparation to refuse')
}

function newService(repo: TempRepo, options: GitServiceOptions = {}): GitService {
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...options })
  services.push(service)
  return service
}

async function readyWorktree(service: GitService, projectId: string, name: string): Promise<Worktree> {
  const pending = await service.createWorktree({ projectId, name })
  return service.whenSettled(pending.id)
}

describe('preparing a new checkout', () => {
  it('symlinks a linked directory at the primary checkout rather than copying it', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)

    await prepareWorktree(repo.runner, {
      repoPath: repo.repoPath,
      worktreePath,
      linkedPaths: ['node_modules']
    })

    const link = path.join(worktreePath, 'node_modules')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(path.join(repo.repoPath, 'node_modules'))
    // Reachable through the link, which is the whole point: `npm test` in this
    // checkout resolves the same install the primary checkout has.
    expect(existsSync(path.join(link, 'left-pad/index.js'))).toBe(true)
  })

  it('copies a copied file as a file of its own, so the two can diverge', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)

    await prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, copiedPaths: ['.env'] })

    const copy = path.join(worktreePath, '.env')
    expect((await lstat(copy)).isSymbolicLink()).toBe(false)
    expect(await readFile(copy, 'utf8')).toBe('TOKEN=hunter2\n')

    await writeFile(copy, 'TOKEN=something-else\n', 'utf8')
    expect(await readFile(path.join(repo.repoPath, '.env'), 'utf8')).toBe('TOKEN=hunter2\n')
  })

  it('refuses a tracked path by name, on either list', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)

    const linked = await refusal(
      prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, linkedPaths: ['src'] })
    )
    expect(linked.code).toBe(ErrorCode.Conflict)
    expect(linked.message).toContain('src')
    expect(linked.message).toContain('tracked by git')

    const copied = await refusal(
      prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, copiedPaths: ['src/index.ts'] })
    )
    expect(copied.message).toContain('src/index.ts')
    expect(copied.message).toContain('tracked by git')
    expect(existsSync(path.join(worktreePath, 'src/index.ts'))).toBe(true) // git's own copy, untouched
  })

  it('refuses a path no ignore rule covers, rather than smuggling it past git', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)
    await repo.write('notes.txt', 'not ignored, not committed\n')

    const error = await refusal(
      prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, copiedPaths: ['notes.txt'] })
    )

    expect(error.message).toContain('notes.txt')
    expect(error.message).toContain('not ignored')
    expect(existsSync(path.join(worktreePath, 'notes.txt'))).toBe(false)
  })

  it('refuses a path that is not in the primary checkout', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)

    const error = await refusal(
      prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, linkedPaths: ['.cache'] })
    )

    expect(error.message).toContain('.cache')
    expect(error.message).toContain(repo.repoPath)
  })

  it('refuses a file on the linked list and says which list it belongs on', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)
    await repo.write('vendor.bin', 'binary-ish\n')

    const error = await refusal(
      prepareWorktree(repo.runner, { repoPath: repo.repoPath, worktreePath, linkedPaths: ['vendor.bin'] })
    )

    expect(error.message).toContain('vendor.bin')
    expect(error.message).toContain('link directories, copy files')
  })

  it('refuses a path that leaves the repository, or names somewhere absolute', () => {
    expect(() => normalizePreparedPath('../../etc')).toThrow(/leaves the repository/)
    expect(() => normalizePreparedPath('/etc/passwd')).toThrow(/absolute/)
    expect(() => normalizePreparedPath('  ')).toThrow(/blank/)
    expect(normalizePreparedPath(' ./packages//app/node_modules/ ')).toBe('packages/app/node_modules')
  })
})

describe('the copy budget', () => {
  const tiny: CopyBudget = { maxBytes: 64 * 1024, maxEntries: 4 }

  /** Something with more entries than anyone should copy, in miniature. */
  async function manyEntries(repo: TempRepo): Promise<void> {
    for (let index = 0; index < 12; index += 1) {
      await repo.write(`.cache/package-${index}/index.js`, 'module.exports = 1\n')
    }
  }

  it('refuses a directory of too many entries before anything is written', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)
    await manyEntries(repo)

    const error = await refusal(
      prepareWorktree(repo.runner, {
        repoPath: repo.repoPath,
        worktreePath,
        // Both lists, so the assertion below is about the whole preparation and
        // not only about the entry that was refused: the budget is checked
        // before the first symlink exists, so neither of these landed.
        linkedPaths: ['node_modules'],
        copiedPaths: ['.env', '.cache'],
        budget: tiny
      })
    )

    expect(error.message).toContain('.cache')
    expect(error.message).toContain(`${tiny.maxEntries} entries`)
    expect(existsSync(path.join(worktreePath, '.cache'))).toBe(false)
    expect(existsSync(path.join(worktreePath, '.env'))).toBe(false)
    expect(existsSync(path.join(worktreePath, 'node_modules'))).toBe(false)
  })

  it('refuses on bytes as well as on entries', async () => {
    const repo = await fixture()
    const worktreePath = await checkout(repo)
    await repo.write('.cache/one-big-file', 'x'.repeat(200 * 1024))

    const error = await refusal(
      prepareWorktree(repo.runner, {
        repoPath: repo.repoPath,
        worktreePath,
        copiedPaths: ['.cache'],
        budget: tiny
      })
    )

    expect(error.message).toContain('.cache')
    expect(error.message).toContain('copy budget')
    expect(existsSync(path.join(worktreePath, '.cache'))).toBe(false)
  })
})

describe('a project that carries paths over', () => {
  it('prepares the checkout before the row is ready, so no pane opens on a half-built one', async () => {
    const repo = await fixture()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const configured = await service.setProjectPaths({
      projectId: project.id,
      linkedPaths: ['node_modules'],
      copiedPaths: ['.env']
    })
    expect(configured.linkedPaths).toEqual(['node_modules'])
    expect(configured.copiedPaths).toEqual(['.env'])

    const worktree = await readyWorktree(service, project.id, 'run the tests')

    expect(worktree.state).toBe('ready')
    expect((await lstat(path.join(worktree.path, 'node_modules'))).isSymbolicLink()).toBe(true)
    expect(await readFile(path.join(worktree.path, '.env'), 'utf8')).toBe('TOKEN=hunter2\n')
  })

  it('fails the row with the offending path named, and leaves no checkout behind', async () => {
    const repo = await fixture()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, linkedPaths: ['node_modules', 'src'] })

    const worktree = await readyWorktree(service, project.id, 'doomed')

    expect(worktree.state).toBe('failed')
    expect(worktree.error).toContain('src')
    expect(worktree.error).toContain('tracked by git')
    expect(existsSync(worktree.path)).toBe(false)
  })

  it('clears a list when given an empty one, and refuses a path that leaves the repository', async () => {
    const repo = await fixture()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    await service.setProjectPaths({ projectId: project.id, copiedPaths: ['.env'] })
    const cleared = await service.setProjectPaths({ projectId: project.id, copiedPaths: [] })
    expect(cleared.copiedPaths).toBeUndefined()

    await expect(service.setProjectPaths({ projectId: project.id, linkedPaths: ['../elsewhere'] })).rejects.toThrow(
      /leaves the repository/
    )
  })
})

describe('removing a worktree that has a symlinked directory in it', () => {
  async function prepared(linked: string): Promise<{ repo: TempRepo; service: GitService; worktree: Worktree }> {
    const repo = await fixture()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, linkedPaths: [linked] })
    const worktree = await readyWorktree(service, project.id, 'link me')
    expect(worktree.state).toBe('ready')
    return { repo, service, worktree }
  }

  it('names the link in the ignored-files refusal, when the rule covers a symlink', async () => {
    // `.venv` with no trailing slash matches anything of that name, symlink
    // included, so the safeguard sees it and says which entry it is refusing
    // over — exactly as it would for a real directory.
    const { service, worktree } = await prepared('.venv')

    await expect(service.removeWorktree({ worktreeId: worktree.id })).rejects.toThrow(/ignored/)

    expect(existsSync(worktree.path)).toBe(true)
  })

  it('still refuses when the rule has a trailing slash and git calls the link untracked', async () => {
    // `node_modules/` matches directories and a symlink is not one, so git does
    // not consider the link ignored at all: it is an untracked file, and the
    // refusal is the one `git worktree remove` gives for a dirty checkout. A
    // different sentence, the same answer — nothing is deleted, and in
    // particular git never treats the link as a directory whose contents are
    // about to go.
    const { service, worktree } = await prepared('node_modules')

    await expect(service.removeWorktree({ worktreeId: worktree.id })).rejects.toThrow(/uncommitted|ignored/)

    expect(existsSync(worktree.path)).toBe(true)
  })

  it('deletes the link and not what it points at', async () => {
    const { repo, service, worktree } = await prepared('node_modules')

    await service.removeWorktree({ worktreeId: worktree.id, force: true })

    expect(existsSync(worktree.path)).toBe(false)
    // The line this whole block exists for: a forced removal deletes everything
    // in the checkout, and the primary checkout's install is on the other end
    // of one of those entries. git unlinks the symlink rather than walking it.
    expect(await readFile(path.join(repo.repoPath, 'node_modules/left-pad/index.js'), 'utf8')).toContain('module')
  })
})
