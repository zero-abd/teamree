// The Files tab's two reads, against a real repository.
//
// Both are questions git already answers — what is here, and which of it is
// ignored — and the only thing this file adds to git's answer is where it is
// allowed to look. So the cases worth having are the ones where a wrong answer
// is quiet: an ignored file drawn like a tracked one, a symlink read as the
// thing it points at, a `..` that reads a directory the worktree does not own.

import { symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { createTempRepo, type TempRepo } from './testRepository'
import { findWorktreeFiles, readWorktreeFiles, resolveInsideWorktree } from './worktreeFiles'

let repo: TempRepo | null = null

afterEach(async () => {
  await repo?.cleanup()
  repo = null
})

/** A checkout with a tracked tree, an ignored corner, and a symlink. */
async function fixture(): Promise<TempRepo> {
  const made = await createTempRepo()
  await made.write('.gitignore', 'dist/\n*.log\n')
  await made.write('src/app.ts', 'export const app = 1\n')
  await made.write('src/util/strings.ts', 'export const s = ""\n')
  await made.write('docs/guide.md', '# guide\n')
  await made.commit('a tree to list')
  // Ignored things on disk, so the listing has something to dim.
  await made.write('dist/bundle.js', 'built\n')
  await made.write('debug.log', 'noise\n')
  // Untracked but not ignored: a file an agent just wrote.
  await made.write('src/new.ts', 'export const fresh = true\n')
  await symlink(path.join(made.repoPath, 'docs'), path.join(made.repoPath, 'docs-link'))
  return made
}

describe('readWorktreeFiles', () => {
  it('lists one directory, directories first, and says which entries git ignores', async () => {
    repo = await fixture()

    const listed = await readWorktreeFiles(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(listed.worktreeId).toBe('wt')
    expect(listed.path).toBe('')
    // Directories before files, each half in name order — the case-blind
    // order a file manager uses, so `README.md` is not sorted above `debug.log`
    // by the accident of its capital.
    expect(listed.entries.map((entry) => entry.name)).toEqual([
      'dist',
      'docs',
      'src',
      '.gitignore',
      'debug.log',
      'docs-link',
      'README.md'
    ])
    const byName = Object.fromEntries(listed.entries.map((entry) => [entry.name, entry]))
    expect(byName.dist).toMatchObject({ kind: 'dir', ignored: true })
    expect(byName['debug.log']).toMatchObject({ kind: 'file', ignored: true })
    expect(byName.src).toMatchObject({ kind: 'dir', ignored: false })
    expect(byName['README.md']).toMatchObject({ kind: 'file', ignored: false })
    // A symlink is reported as one, not as whatever it points at.
    expect(byName['docs-link']).toMatchObject({ kind: 'symlink' })
    // And never the repository's own bookkeeping.
    expect(byName['.git']).toBeUndefined()
  })

  it('reads a subdirectory by its relative path, without recursing', async () => {
    repo = await fixture()

    const listed = await readWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'src'
    })

    expect(listed.path).toBe('src')
    expect(listed.entries.map((entry) => entry.name)).toEqual(['util', 'app.ts', 'new.ts'])
    // `strings.ts` is one level down and is not here: one directory per call.
    expect(listed.entries.some((entry) => entry.name === 'strings.ts')).toBe(false)
    // An untracked file is not an ignored one.
    expect(listed.entries.find((entry) => entry.name === 'new.ts')?.ignored).toBe(false)
  })

  it('refuses a path that leaves the worktree', async () => {
    repo = await fixture()

    for (const outside of ['..', '../', 'src/../..', '/etc', path.join(repo.base, 'worktrees')]) {
      await expect(
        readWorktreeFiles(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: outside }),
        outside
      ).rejects.toBeInstanceOf(GitServiceError)
    }
  })

  it('refuses a directory that is not there rather than answering with nothing', async () => {
    repo = await fixture()

    await expect(
      readWorktreeFiles(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: 'nowhere' })
    ).rejects.toBeInstanceOf(GitServiceError)
  })

  it('stops at the limit and says so', async () => {
    repo = await fixture()

    const listed = await readWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      limit: 2
    })

    expect(listed.entries).toHaveLength(2)
    expect(listed.truncated).toBe(true)
  })
})

describe('resolveInsideWorktree', () => {
  it('keeps the root and anything under it, and nothing else', () => {
    const root = path.join(path.sep, 'repos', 'thing')
    expect(resolveInsideWorktree(root, undefined)).toEqual({ absolute: root, relative: '' })
    expect(resolveInsideWorktree(root, 'src/util')).toEqual({
      absolute: path.join(root, 'src', 'util'),
      relative: 'src/util'
    })
    expect(resolveInsideWorktree(root, 'src/../docs')).toEqual({
      absolute: path.join(root, 'docs'),
      relative: 'docs'
    })
    expect(resolveInsideWorktree(root, '..')).toBeNull()
    expect(resolveInsideWorktree(root, '../thing-2')).toBeNull()
    expect(resolveInsideWorktree(root, path.join(path.sep, 'elsewhere'))).toBeNull()
  })
})

describe('findWorktreeFiles', () => {
  it('matches a substring of the path, whatever its case, over tracked and untracked files', async () => {
    repo = await fixture()

    const found = await findWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      query: 'TS'
    })

    expect(found.paths).toEqual(['src/app.ts', 'src/new.ts', 'src/util/strings.ts'])
    expect(found.truncated).toBe(false)
  })

  it('leaves ignored files out', async () => {
    repo = await fixture()

    const found = await findWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      query: 'log'
    })

    expect(found.paths).toEqual([])
  })

  it('honours the limit and reports the cut', async () => {
    repo = await fixture()

    const found = await findWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      query: 's',
      limit: 2
    })

    expect(found.paths).toHaveLength(2)
    expect(found.truncated).toBe(true)
  })

  it('answers an empty query with nothing rather than everything', async () => {
    repo = await fixture()

    const found = await findWorktreeFiles(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      query: '   '
    })

    expect(found.paths).toEqual([])
    expect(found.truncated).toBe(false)
  })
})
