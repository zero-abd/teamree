// How the CLI resolves the path an agent is standing in to a worktree it knows.
//
// An agent almost always names a worktree by `$PWD`, and the spelling it hands
// over is whatever its shell recorded — a different case on Windows or macOS, a
// symlinked temp or /var path on macOS, a directory that a failed create left
// off disk. All three have to land on the same record.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, pathComparisonKey, selectOne } from '../../src/cli/selectors'

const CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32' || process.platform === 'darwin'

const worktree = (id: string, name: string, checkout: string) => ({ id, name, path: checkout, aliases: [name] })

const makeTempDir = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix))

describe('canonicalPath', () => {
  it('makes a relative token absolute against the working directory', () => {
    expect(canonicalPath('a/b/..')).toBe(path.join(canonicalPath(process.cwd()), 'a'))
  })

  // The defect: the old form gave up on a path that was not on disk, so a
  // checkout that a failed create had removed could no longer be named at all
  // on a platform where the temp root is behind a symlink.
  it('resolves a symlinked ancestor even when the leaf is gone', () => {
    const real = makeTempDir('cli-real-')
    const home = makeTempDir('cli-link-')
    const link = path.join(home, 'worktrees')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')

    expect(canonicalPath(path.join(link, 'never-created'))).toBe(path.join(realpathSync.native(real), 'never-created'))
  })
})

describe('pathComparisonKey', () => {
  it('folds exactly as far as the running filesystem does', () => {
    const root = makeTempDir('cli-case-')
    mkdirSync(path.join(root, 'MixedCase'))
    const same = pathComparisonKey(path.join(root, 'MIXEDCASE')) === pathComparisonKey(path.join(root, 'MixedCase'))
    expect(same).toBe(CASE_INSENSITIVE_FILESYSTEM)
  })

  it('ignores a case difference in a path that is not on disk on Windows and macOS', () => {
    const root = makeTempDir('cli-absent-')
    const same = pathComparisonKey(path.join(root, 'Pending')) === pathComparisonKey(path.join(root, 'pending'))
    expect(same).toBe(CASE_INSENSITIVE_FILESYSTEM)
  })
})

describe('selectOne by path', () => {
  it('finds a worktree named by its own recorded path', () => {
    const root = makeTempDir('cli-select-')
    const checkout = path.join(root, 'app', 'login')
    mkdirSync(checkout, { recursive: true })
    const items = [worktree('wt_1', 'login', checkout), worktree('wt_2', 'other', path.join(root, 'app', 'other'))]

    expect(selectOne('worktree', checkout, items).id).toBe('wt_1')
  })

  it('finds it through the symlink the shell followed, or did not', () => {
    const real = makeTempDir('cli-sreal-')
    const home = makeTempDir('cli-slink-')
    const link = path.join(home, 'worktrees')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    mkdirSync(path.join(real, 'login'))

    const items = [worktree('wt_1', 'login', path.join(real, 'login'))]
    expect(selectOne('worktree', path.join(link, 'login'), items).id).toBe('wt_1')
  })

  it('finds it through the case the shell recorded, wherever that is the same file', () => {
    const root = makeTempDir('cli-scase-')
    const checkout = path.join(root, 'Login')
    mkdirSync(checkout)
    const items = [worktree('wt_1', 'login', checkout)]

    if (CASE_INSENSITIVE_FILESYSTEM) {
      expect(selectOne('worktree', path.join(root, 'LOGIN'), items).id).toBe('wt_1')
    } else {
      expect(() => selectOne('worktree', path.join(root, 'LOGIN'), items)).toThrow(/No worktree matches/)
    }
  })

  it('still prefers an id, a name and an alias over a path', () => {
    const items = [worktree('wt_1', 'login', '/nowhere/login'), worktree('wt_2', 'other', '/nowhere/other')]
    expect(selectOne('worktree', 'wt_2', items).id).toBe('wt_2')
    expect(selectOne('worktree', 'login', items).id).toBe('wt_1')
    expect(selectOne('worktree', 'LOGIN', items).id).toBe('wt_1')
  })

  it('refuses to guess between two records with the same path', () => {
    const items = [worktree('wt_1', 'a', '/nowhere/same'), worktree('wt_2', 'b', '/nowhere/same')]
    expect(() => selectOne('worktree', '/nowhere/same', items)).toThrow(/matches 2 worktrees by path/)
  })
})
