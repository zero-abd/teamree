import { describe, expect, it } from 'vitest'
import type { WorktreeChanges, WorktreeFiles } from '@shared/entities'
import {
  applyListing,
  beginListing,
  changesUnder,
  childPath,
  emptyTree,
  expandDir,
  failListing,
  foldDir,
  statusLetterFor,
  treeRows
} from './fileTree'

const listing = (path: string, names: [string, 'file' | 'dir' | 'symlink', boolean?][]): WorktreeFiles => ({
  worktreeId: 'wt',
  path,
  entries: names.map(([name, kind, ignored]) => ({ name, kind, ignored: ignored ?? false })),
  truncated: false,
  readAt: 0
})

const ROOT = listing('', [
  ['dist', 'dir', true],
  ['src', 'dir'],
  ['README.md', 'file'],
  ['docs-link', 'symlink']
])

const SRC = listing('src', [
  ['util', 'dir'],
  ['app.ts', 'file']
])

describe('the rows a tree draws', () => {
  it('draws nothing before the root has been read', () => {
    expect(treeRows(emptyTree())).toEqual([])
  })

  it('draws the root listing in its own order, at depth zero', () => {
    const tree = applyListing(emptyTree(), ROOT)
    expect(treeRows(tree).map((row) => [row.path, row.depth, row.kind, row.ignored])).toEqual([
      ['dist', 0, 'dir', true],
      ['src', 0, 'dir', false],
      ['README.md', 0, 'file', false],
      ['docs-link', 0, 'symlink', false]
    ])
  })

  it('nests a directory’s listing under it once it is expanded', () => {
    const tree = applyListing(applyListing(expandDir(emptyTree(), 'src').tree, ROOT), SRC)
    expect(treeRows(tree).map((row) => `${'  '.repeat(row.depth)}${row.name}`)).toEqual([
      'dist',
      'src',
      '  util',
      '  app.ts',
      'README.md',
      'docs-link'
    ])
  })

  // What folding keeps is the point: the listing is not thrown away, so opening
  // the folder again draws what was there while the fresh read is in flight.
  it('hides a folded directory’s rows and keeps its listing for the next open', () => {
    let tree = applyListing(applyListing(expandDir(emptyTree(), 'src').tree, ROOT), SRC)
    tree = foldDir(tree, 'src')
    expect(treeRows(tree).map((row) => row.path)).toEqual(['dist', 'src', 'README.md', 'docs-link'])
    expect(treeRows(tree).find((row) => row.path === 'src')?.expanded).toBe(false)

    // No watcher: expanding again is what asks for a re-read, and the answer
    // says so.
    const again = expandDir(tree, 'src')
    expect(again.read).toBe(true)
    expect(treeRows(again.tree).map((row) => row.path)).toContain('src/app.ts')
  })

  it('marks a directory as loading while its read is out, and says when it failed', () => {
    let tree = applyListing(expandDir(emptyTree(), 'src').tree, ROOT)
    tree = beginListing(tree, 'src')
    expect(treeRows(tree).find((row) => row.path === 'src')?.loading).toBe(true)

    tree = failListing(tree, 'src', 'no such directory')
    const row = treeRows(tree).find((entry) => entry.path === 'src')
    expect(row?.loading).toBe(false)
    expect(row?.error).toBe('no such directory')
  })

  it('keeps a listing that arrives for a folded directory without drawing it', () => {
    const tree = applyListing(applyListing(emptyTree(), ROOT), SRC)
    expect(treeRows(tree).map((row) => row.path)).toEqual(['dist', 'src', 'README.md', 'docs-link'])
    expect(treeRows(expandDir(tree, 'src').tree).map((row) => row.path)).toContain('src/util')
  })

  it('joins a child onto its directory, and onto the root without a slash', () => {
    expect(childPath('', 'src')).toBe('src')
    expect(childPath('src', 'util')).toBe('src/util')
  })
})

describe('what git says about a row', () => {
  const changes: WorktreeChanges = {
    worktreeId: 'wt',
    changes: [
      { path: 'src/app.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'src/util/new.ts', kind: 'untracked', staged: false, unstaged: true },
      { path: 'README.md', kind: 'deleted', staged: true, unstaged: false }
    ],
    total: 3,
    limit: 500,
    truncated: false,
    readAt: 0
  }

  // The same letter the changes tab prints, so a file is not `M` on one tab
  // and `modified` on the other.
  it('gives a changed file the letter the changes tab uses', () => {
    expect(statusLetterFor('src/app.ts', changes)).toBe('M')
    expect(statusLetterFor('src/util/new.ts', changes)).toBe('?')
    expect(statusLetterFor('README.md', changes)).toBe('D')
    expect(statusLetterFor('src/other.ts', changes)).toBeNull()
    expect(statusLetterFor('src/app.ts', undefined)).toBeNull()
  })

  it('counts the changes under a directory, and not the ones beside it', () => {
    expect(changesUnder('src', changes)).toBe(2)
    expect(changesUnder('src/util', changes)).toBe(1)
    expect(changesUnder('docs', changes)).toBe(0)
    // `src` is not under `s`.
    expect(changesUnder('s', changes)).toBe(0)
  })
})
