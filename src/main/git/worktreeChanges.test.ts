import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cutToBytes, parseChangeRecords, readWorktreeChanges, readWorktreeDiff, sortChanges } from './worktreeChanges'
import { createTempRepo, type TempRepo } from './testRepository'

/** Builds a NUL-separated status stream the way git writes one. */
const records = (...entries: string[]): string => entries.map((entry) => `${entry}\0`).join('')

describe('parseChangeRecords', () => {
  it('reads an ordinary entry, keeping which side of the index it is on', () => {
    const parsed = parseChangeRecords(
      records('1 M. N... 100644 100644 100644 abc123 def456 src/app.ts', '1 .M N... 100644 100644 100644 a b docs/x.md')
    )

    expect(parsed).toEqual([
      { path: 'src/app.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'docs/x.md', kind: 'modified', staged: false, unstaged: true }
    ])
  })

  it('counts a file staged and then edited as both, and names it by the index', () => {
    const [change] = parseChangeRecords(records('1 AM N... 000000 100644 100644 000000 abc src/new.ts'))

    expect(change).toEqual({ path: 'src/new.ts', kind: 'added', staged: true, unstaged: true })
  })

  it('takes the record after a rename as where it came from, not as a change', () => {
    const parsed = parseChangeRecords(
      records('2 R. N... 100644 100644 100644 abc def R100 src/new-name.ts', 'src/old-name.ts')
    )

    expect(parsed).toEqual([
      { path: 'src/new-name.ts', kind: 'renamed', staged: true, unstaged: false, from: 'src/old-name.ts' }
    ])
  })

  it('keeps a path exactly as git gave it, spaces and all', () => {
    const parsed = parseChangeRecords(records('1 .M N... 100644 100644 100644 a b docs/release notes v2.md'))

    expect(parsed[0]?.path).toBe('docs/release notes v2.md')
  })

  it('reads untracked and unmerged entries, and skips headers and ignored files', () => {
    const parsed = parseChangeRecords(
      records(
        '# branch.head main',
        '# branch.ab +1 -0',
        '? build/out.log',
        'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
        '! node_modules/x'
      )
    )

    expect(parsed).toEqual([
      { path: 'build/out.log', kind: 'untracked', staged: false, unstaged: true },
      { path: 'src/conflict.ts', kind: 'conflicted', staged: false, unstaged: true }
    ])
  })

  it('names each kind by its code', () => {
    const parsed = parseChangeRecords(
      records(
        '1 D. N... 100644 000000 000000 a b gone.ts',
        '1 .T N... 120000 100644 100644 a b link.ts',
        '2 C. N... 100644 100644 100644 a b C75 copy.ts',
        'origin.ts'
      )
    )

    expect(parsed.map((change) => change.kind)).toEqual(['deleted', 'typeChanged', 'copied'])
  })

  it('is unbothered by an empty stream', () => {
    expect(parseChangeRecords('')).toEqual([])
  })
})

describe('sortChanges', () => {
  it('puts what blocks a commit first, then staged, then the rest', () => {
    const sorted = sortChanges([
      { path: 'z-untracked.ts', kind: 'untracked', staged: false, unstaged: true },
      { path: 'b-unstaged.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'a-staged.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'c-conflict.ts', kind: 'conflicted', staged: false, unstaged: true }
    ])

    expect(sorted.map((change) => change.path)).toEqual([
      'c-conflict.ts',
      'a-staged.ts',
      'b-unstaged.ts',
      'z-untracked.ts'
    ])
  })

  it('orders alphabetically inside a group, so rows do not move under the cursor', () => {
    const sorted = sortChanges([
      { path: 'src/b.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }
    ])

    expect(sorted.map((change) => change.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('cutToBytes', () => {
  it('leaves anything under the ceiling alone', () => {
    expect(cutToBytes('short\n', 100)).toBe('short\n')
  })

  it('cuts back to the last whole line', () => {
    expect(cutToBytes('one\ntwo\nthree\n', 9)).toBe('one\ntwo\n')
  })

  it('never leaves half a character behind', () => {
    // Each of these is three bytes, so a cut at 10 lands mid-character.
    const cut = cutToBytes(`${'字'.repeat(10)}\n`, 10)
    expect(cut).not.toContain('�')
  })
})

describe('changes and diffs against a real repository', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  it('reports every kind of change git can be in the middle of', async () => {
    const repo = await repository()
    await repo.write('tracked.ts', 'export const a = 1\n')
    await repo.write('renamed-from.ts', 'export const b = 2\n')
    await repo.commit('add two files')

    await repo.write('tracked.ts', 'export const a = 2\n')
    await repo.write('staged.ts', 'export const c = 3\n')
    await repo.git(['add', 'staged.ts'])
    await repo.git(['mv', 'renamed-from.ts', 'renamed-to.ts'])
    await repo.write('untracked.ts', 'export const d = 4\n')

    const result = await readWorktreeChanges(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      now: () => 1234
    })

    expect(result.worktreeId).toBe('wt')
    expect(result.readAt).toBe(1234)
    expect(result.truncated).toBe(false)
    const byPath = new Map(result.changes.map((change) => [change.path, change]))
    expect(byPath.get('tracked.ts')).toMatchObject({ kind: 'modified', staged: false, unstaged: true })
    expect(byPath.get('staged.ts')).toMatchObject({ kind: 'added', staged: true, unstaged: false })
    expect(byPath.get('renamed-to.ts')).toMatchObject({ kind: 'renamed', from: 'renamed-from.ts', staged: true })
    expect(byPath.get('untracked.ts')).toMatchObject({ kind: 'untracked', staged: false, unstaged: true })
  })

  it('caps the list and says that it capped it', async () => {
    const repo = await repository()
    for (let index = 0; index < 6; index += 1) await repo.write(`file-${index}.ts`, 'export {}\n')

    const result = await readWorktreeChanges(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      limit: 2
    })

    expect(result.changes).toHaveLength(2)
    expect(result.total).toBe(6)
    expect(result.truncated).toBe(true)
  })

  it('says nothing changed when nothing has', async () => {
    const repo = await repository()

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(result.changes).toEqual([])
    expect(result.total).toBe(0)
  })

  it('returns the patch for a tracked edit', async () => {
    const repo = await repository()
    await repo.write('src/app.ts', 'const one = 1\n')
    await repo.commit('add app')
    await repo.write('src/app.ts', 'const one = 2\n')

    const diff = await readWorktreeDiff(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(diff.patch).toContain('-const one = 1')
    expect(diff.patch).toContain('+const one = 2')
    expect(diff.staged).toBe(false)
    expect(diff.truncated).toBe(false)
  })

  it('diffs the index rather than the tree when asked for what is staged', async () => {
    const repo = await repository()
    await repo.write('src/app.ts', 'const one = 1\n')
    await repo.commit('add app')
    await repo.write('src/app.ts', 'const one = 2\n')
    await repo.git(['add', 'src/app.ts'])
    await repo.write('src/app.ts', 'const one = 3\n')

    const staged = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      staged: true
    })
    const working = await readWorktreeDiff(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(staged.patch).toContain('+const one = 2')
    expect(working.patch).toContain('+const one = 3')
  })

  it('restricts the patch to the path it was given', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'a\n')
    await repo.write('b.ts', 'b\n')
    await repo.commit('two files')
    await repo.write('a.ts', 'a changed\n')
    await repo.write('b.ts', 'b changed\n')

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'a.ts'
    })

    expect(diff.path).toBe('a.ts')
    expect(diff.patch).toContain('a changed')
    expect(diff.patch).not.toContain('b changed')
  })

  // The case a new branch is usually full of, and the one plain `git diff`
  // answers with silence.
  it('shows an untracked file as the patch that adds it', async () => {
    const repo = await repository()
    await repo.write('brand-new.ts', 'export const fresh = true\n')

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'brand-new.ts'
    })

    expect(diff.patch).toContain('+export const fresh = true')
  })

  it('leaves the patch empty for a path that is not there at all', async () => {
    const repo = await repository()

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'no/such/file.ts'
    })

    expect(diff.patch).toBe('')
    expect(diff.truncated).toBe(false)
  })

  it('cuts a patch at the ceiling and says so', async () => {
    const repo = await repository()
    await repo.write('big.txt', 'seed\n')
    await repo.commit('seed')
    await repo.write('big.txt', `${Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n')}\n`)

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      maxBytes: 200
    })

    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(200)
    expect(diff.patch.endsWith('\n')).toBe(true)
  })

  it('reads a worktree that is not the primary checkout', async () => {
    const repo = await repository()
    const checkout = path.join(repo.worktreesRoot, 'feature')
    await repo.git(['worktree', 'add', '-b', 'feature', checkout])
    await repo.write('only-here.ts', 'export {}\n', checkout)

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: checkout })

    expect(result.changes.map((change) => change.path)).toEqual(['only-here.ts'])
    await rm(checkout, { recursive: true, force: true })
  })
})
