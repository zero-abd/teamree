import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cutToBytes, parseChangeRecords, readWorktreeChanges, readWorktreeDiff, sortChanges } from './worktreeChanges'
import { createTempRepo, type TempRepo } from './testRepository'
import { discardPath } from './worktreeDiscard'

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

  it('lists each file in a new folder, so each can be opened', async () => {
    const repo = await repository()
    await repo.write('docs/NOTES.md', 'one\ntwo\n')
    await repo.write('docs/deep/more.md', 'three\n')

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(result.changes.map((change) => change.path)).toEqual(['docs/deep/more.md', 'docs/NOTES.md'])
  })

  it('folds new files back into their folders once there are more than twenty', async () => {
    const repo = await repository()
    for (let index = 0; index < 21; index += 1) await repo.write(`generated/file-${index}.ts`, 'export {}\n')
    await repo.write('notes.md', 'x\n')

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(result.changes.map((change) => change.path)).toEqual(['generated/', 'notes.md'])
  })

  it('counts lines added and removed per file, a new file as all added and a binary one not at all', async () => {
    const repo = await repository()
    await repo.write('src/math.ts', 'a\nb\nc\n')
    await repo.write('old.ts', 'x\n')
    await repo.commit('seed')
    await repo.write('src/math.ts', 'a\nB\nc\nd\ne\n')
    await repo.git(['add', 'src/math.ts'])
    await repo.write('src/math.ts', 'a\nB\nc\nd\ne\nf\n')
    await repo.git(['rm', '-q', 'old.ts'])
    await repo.write('docs/NOTES.md', 'one\ntwo\nthree')
    await writeFile(path.join(repo.repoPath, 'logo.bin'), Buffer.from([0, 1, 2, 0, 3]))

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })
    const byPath = new Map(result.changes.map((change) => [change.path, change]))

    expect(byPath.get('src/math.ts')).toMatchObject({ added: 4, removed: 1 })
    expect(byPath.get('old.ts')).toMatchObject({ added: 0, removed: 1 })
    expect(byPath.get('docs/NOTES.md')).toMatchObject({ added: 3, removed: 0 })
    expect(byPath.get('logo.bin')).not.toHaveProperty('added')
  })

  it('counts a renamed file against where it came from', async () => {
    const repo = await repository()
    await repo.write('from.ts', 'one\ntwo\nthree\nfour\n')
    await repo.commit('seed')
    await repo.git(['mv', 'from.ts', 'to.ts'])
    await repo.write('to.ts', 'one\ntwo\nthree\nfour\nfive\n')

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(result.changes).toEqual([expect.objectContaining({ path: 'to.ts', from: 'from.ts', added: 1, removed: 0 })])
  })

  it('counts nothing, and still lists, on a branch with no commit yet', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'x\n')
    await repo.git(['add', 'a.ts'])

    const result = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(result.changes.map((change) => change.path)).toEqual(['a.ts'])
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

  // The case plain `git diff` answers with silence.
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

  // A file past the runner's 32MB ceiling came back as a failure, which the
  // panel rendered as "No patch for this path".
  it('cuts a very large untracked file down rather than failing to read it', async () => {
    const repo = await repository()
    // Comfortably past the runner's hard ceiling, whatever the patch budget is.
    await repo.write('huge.log', `${'x'.repeat(79)}\n`.repeat(500_000))

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'huge.log',
      maxBytes: 64 * 1024
    })

    expect(diff.truncated).toBe(true)
    expect(diff.patch).toContain('+xxx')
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  // `node_modules/` matches directories, a symlink is not one, so the link
  // teamree made is reported untracked.
  it('leaves out the directory teamree linked in, and reports it when nothing says it is ours', async () => {
    const repo = await repository()
    await repo.write('.gitignore', 'node_modules/\n')
    await repo.commit('ignore installed packages')
    await mkdir(path.join(repo.base, 'installed'), { recursive: true })
    await symlink(path.join(repo.base, 'installed'), path.join(repo.repoPath, 'node_modules'))

    const unfiltered = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })
    const result = await readWorktreeChanges(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      prepared: { linkedPaths: ['node_modules'] }
    })

    expect(unfiltered.changes.map((change) => change.path)).toEqual(['node_modules'])
    expect(result.changes).toEqual([])
    expect(result.total).toBe(0)
  })

  // Ours until somebody stages it, or the fix would hide a file from its commit.
  it('keeps showing a copied file once git has been told about it', async () => {
    const repo = await repository()
    await repo.write('.gitignore', '.env\n')
    await repo.commit('ignore the environment')
    await repo.write('.env', 'TOKEN=hunter2\n')
    const prepared = { copiedPaths: ['.env'] }

    const before = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, prepared })
    await repo.git(['add', '--force', '.env'])
    const after = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, prepared })

    expect(before.changes).toEqual([])
    expect(after.changes.map((change) => change.path)).toEqual(['.env'])
  })

  // Three changes listed and one shown was the whole complaint.
  it('shows untracked files in the whole-worktree patch, not only when named', async () => {
    const repo = await repository()
    await repo.write('tracked.ts', 'const one = 1\n')
    await repo.commit('add tracked')
    await repo.write('tracked.ts', 'const one = 2\n')
    await repo.write('src/brand-new.ts', 'export const fresh = true\n')

    const diff = await readWorktreeDiff(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(diff.patch).toContain('+const one = 2')
    expect(diff.patch).toContain('src/brand-new.ts')
    expect(diff.patch).toContain('+export const fresh = true')
    expect(diff.truncated).toBe(false)
  })

  it('keeps the prepared paths out of the patch, as it keeps them out of the list', async () => {
    const repo = await repository()
    await repo.write('.gitignore', 'node_modules/\n.env\n')
    await repo.commit('ignore what a worktree carries over')
    await mkdir(path.join(repo.base, 'installed'), { recursive: true })
    await symlink(path.join(repo.base, 'installed'), path.join(repo.repoPath, 'node_modules'))
    await repo.write('.env', 'TOKEN=hunter2\n')
    await repo.write('mine.ts', 'export const mine = true\n')

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      prepared: { linkedPaths: ['node_modules'], copiedPaths: ['.env'] }
    })

    expect(diff.patch).toContain('+export const mine = true')
    expect(diff.patch).not.toContain('node_modules')
    expect(diff.patch).not.toContain('.env')
  })

  it('says a binary file differs rather than spelling out its bytes', async () => {
    const repo = await repository()
    await writeFile(path.join(repo.repoPath, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))

    const diff = await readWorktreeDiff(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })

    expect(diff.patch).toContain('Binary files')
    expect(diff.patch).not.toContain('+\u0089PNG')
  })

  // Each untracked file costs a process, so the patch stops and says so.
  it('stops adding untracked files at the cap and calls the patch truncated', async () => {
    const repo = await repository()
    for (let index = 0; index < 4; index += 1) await repo.write(`new-${index}.ts`, 'export {}\n')

    const diff = await readWorktreeDiff(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      untrackedLimit: 2
    })

    expect(diff.truncated).toBe(true)
    expect(diff.patch).toContain('new-0.ts')
    expect(diff.patch).not.toContain('new-3.ts')
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

// An empty `git diff` for one path used to be read as "untracked", so an untouched
// file came back as the patch that adds all of it.
describe('the patch for one path', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const seeded = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.write('.gitignore', 'build.log\n')
    await repo.write('src/math.ts', 'export const one = 1\n')
    await repo.write('src/big.ts', 'export const big = true\n')
    await repo.commit('seed')
    return repo
  }

  const halves = async (repo: TempRepo, file: string): Promise<{ working: string; staged: string }> => {
    const read = (staged: boolean): Promise<{ patch: string }> =>
      readWorktreeDiff(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: file, staged })
    const [working, staged] = await Promise.all([read(false), read(true)])
    return { working: working.patch, staged: staged.patch }
  }

  const changesAt = async (repo: TempRepo, file: string): Promise<number> =>
    (await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: file })).total

  it('is empty for a tracked file nobody touched', async () => {
    const repo = await seeded()

    expect(await halves(repo, 'src/big.ts')).toEqual({ working: '', staged: '' })
    expect(await changesAt(repo, 'src/big.ts')).toBe(0)
  })

  it('is the edit for a tracked file that was changed', async () => {
    const repo = await seeded()
    await repo.write('src/math.ts', 'export const one = 2\n')

    const { working, staged } = await halves(repo, 'src/math.ts')

    expect(working).toContain('-export const one = 1')
    expect(working).toContain('+export const one = 2')
    expect(working).not.toContain('new file')
    expect(staged).toBe('')
    expect(await changesAt(repo, 'src/math.ts')).toBe(1)
  })

  it('is the whole file for one git is not tracking', async () => {
    const repo = await seeded()
    await repo.write('src/fresh/new.ts', 'export const fresh = true\n')

    const { working, staged } = await halves(repo, 'src/fresh/new.ts')

    expect(working).toContain('+export const fresh = true')
    expect(staged).toBe('')
    expect(await changesAt(repo, 'src/fresh/new.ts')).toBe(1)
  })

  it('is empty for an ignored file', async () => {
    const repo = await seeded()
    await repo.write('build.log', 'noise\n')

    expect(await halves(repo, 'build.log')).toEqual({ working: '', staged: '' })
    expect(await changesAt(repo, 'build.log')).toBe(0)
  })

  it('is the removal for a deleted file', async () => {
    const repo = await seeded()
    await rm(path.join(repo.repoPath, 'src/math.ts'))

    const { working } = await halves(repo, 'src/math.ts')

    expect(working).toContain('deleted file')
    expect(working).toContain('-export const one = 1')
  })

  it('keeps a staged-only change in the staged half', async () => {
    const repo = await seeded()
    await repo.write('src/math.ts', 'export const one = 2\n')
    await repo.git(['add', 'src/math.ts'])

    const { working, staged } = await halves(repo, 'src/math.ts')

    expect(working).toBe('')
    expect(staged).toContain('+export const one = 2')
    expect(staged).not.toContain('new file')
  })

  it('keeps a staged rename in the staged half', async () => {
    const repo = await seeded()
    await repo.git(['mv', 'src/math.ts', 'src/sum.ts'])

    const { working, staged } = await halves(repo, 'src/sum.ts')

    expect(working).toBe('')
    expect(staged).toContain('+export const one = 1')
    expect(await changesAt(repo, 'src/sum.ts')).toBe(1)
  })

  it('refuses a path outside the repository', async () => {
    const repo = await seeded()
    await writeFile(path.join(repo.base, 'outside.ts'), 'export {}\n')

    await expect(halves(repo, '../outside.ts')).rejects.toThrow()
  })

  it('is empty again once the change is discarded', async () => {
    const repo = await seeded()
    await repo.write('src/math.ts', 'export const one = 2\n')
    await discardPath(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: 'src/math.ts' })

    expect(await halves(repo, 'src/math.ts')).toEqual({ working: '', staged: '' })
    expect(await changesAt(repo, 'src/math.ts')).toBe(0)
  })
})
