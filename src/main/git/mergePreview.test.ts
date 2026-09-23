import { afterEach, describe, expect, it } from 'vitest'
import { lacksWriteTree, parseMergeTree, readMergePreview } from './mergePreview'
import { createTempRepo, type TempRepo } from './testRepository'

describe('parseMergeTree', () => {
  it('reads the tree of a clean merge, which lists no files at all', () => {
    expect(parseMergeTree('407ba12\0')).toEqual({ tree: '407ba12', conflicts: [] })
  })

  it('reads the conflicted paths and stops at the terminator', () => {
    const raw = ['2e5b0d3', 'a.txt', 'src/b.ts', '', '1', 'a.txt', 'CONFLICT (content)', 'prose'].join('\0')

    expect(parseMergeTree(raw)).toEqual({ tree: '2e5b0d3', conflicts: ['a.txt', 'src/b.ts'] })
  })

  // A modify/delete names the same file twice; listing it twice reads as more damage.
  it('names each path once however many times git mentions it', () => {
    expect(parseMergeTree(['tree', 'b.txt', 'b.txt', ''].join('\0')).conflicts).toEqual(['b.txt'])
  })

  it('is unbothered by empty output', () => {
    expect(parseMergeTree('')).toEqual({ tree: '', conflicts: [] })
  })
})

describe('lacksWriteTree', () => {
  it('recognises a git that does not know the flag', () => {
    expect(lacksWriteTree("error: unknown option `write-tree'")).toBe(true)
    expect(lacksWriteTree('fatal: unknown rev --write-tree')).toBe(true)
    expect(lacksWriteTree('usage: git merge-tree <base-tree> <branch1> <branch2>')).toBe(true)
  })

  // git translates "unknown option" and "usage", not its own subcommand and flag names.
  it('recognises the same refusal from a git that is not speaking English', () => {
    expect(
      lacksWriteTree("error: unbekannte Option: `write-tree'\nAufruf: git merge-tree <base-tree> <branch1> <branch2>")
    ).toBe(true)
  })

  it('does not mistake an ordinary failure for an old git', () => {
    expect(lacksWriteTree('fatal: not a git repository')).toBe(false)
    expect(lacksWriteTree('')).toBe(false)
    expect(lacksWriteTree('fatal: Nicht in einem Git-Repository')).toBe(false)
  })
})

describe('previewing a merge against a real repository', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  /** A branch off main that changes `file` to `content`. */
  async function branch(repo: TempRepo, name: string, file: string, content: string): Promise<void> {
    await repo.git(['checkout', '-q', '-b', name, 'main'])
    await repo.write(file, content)
    await repo.commit(`${name} changes ${file}`)
    await repo.git(['checkout', '-q', 'main'])
  }

  it('says a branch that touches nothing contested is clean', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'one\ntwo\nthree\n')
    await repo.commit('add shared')
    await branch(repo, 'feature', 'other.txt', 'only here\n')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature',
      now: () => 99
    })

    expect(preview).toEqual({
      worktreeId: 'wt',
      baseRef: 'main',
      state: 'clean',
      ahead: 1,
      conflicts: [],
      readAt: 99
    })
  })

  it('names the files that would fight', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'one\ntwo\nthree\n')
    await repo.write('also.txt', 'a\nb\nc\n')
    await repo.commit('add files')
    await branch(repo, 'feature', 'shared.txt', 'one\nFEATURE\nthree\n')
    await repo.write('also.txt', 'a\nMAIN\nc\n')
    await repo.write('shared.txt', 'one\nMAIN\nthree\n')
    await repo.commit('main moves on')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('conflicts')
    expect(preview.conflicts).toEqual(['shared.txt'])
  })

  it('counts a file deleted on one side and edited on the other', async () => {
    const repo = await repository()
    await repo.write('doomed.txt', 'keep\n')
    await repo.commit('add doomed')
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.git(['rm', '-q', 'doomed.txt'])
    await repo.commit('remove it')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('doomed.txt', 'changed\n')
    await repo.commit('edit it')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('conflicts')
    expect(preview.conflicts).toEqual(['doomed.txt'])
  })

  // The whole reason for merge-tree over an actual merge: asking must cost nothing.
  it('leaves the repository exactly as it found it', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'one\n')
    await repo.commit('add shared')
    await branch(repo, 'feature', 'shared.txt', 'feature\n')
    await repo.write('shared.txt', 'main\n')
    await repo.commit('main moves on')

    const before = await repo.git(['rev-parse', 'HEAD'])
    await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(await repo.git(['rev-parse', 'HEAD'])).toBe(before)
    expect(await repo.git(['status', '--porcelain'])).toBe('')
    // No merge was started, so there is nothing to abort.
    expect(await repo.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('refuses to guess when the base ref does not resolve', async () => {
    const repo = await repository()
    await branch(repo, 'feature', 'new.txt', 'hello\n')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'origin/nonexistent',
      branch: 'feature'
    })

    expect(preview.state).toBe('unavailable')
    expect(preview.reason).toContain('origin/nonexistent')
    expect(preview.conflicts).toEqual([])
  })

  // A ref may begin with a dash (`git check-ref-format` accepts `refs/heads/--anything`),
  // and a clone whose HEAD points at one lets `detectBaseRef` hand this a name the far end chose.
  it('refuses a base ref git would read as an option rather than a revision', async () => {
    const repo = await repository()
    await branch(repo, 'feature', 'new.txt', 'hello\n')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: '--output=/dev/null',
      branch: 'feature'
    })

    expect(preview.state).toBe('unavailable')
    expect(preview.reason).toContain('is not a usable git ref')
    expect(preview.reason).toContain('--output=/dev/null')
    expect(preview.ahead).toBe(0)
  })

  it('refuses a branch git would read as an option rather than a revision', async () => {
    const repo = await repository()

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: '--all'
    })

    expect(preview.state).toBe('unavailable')
    expect(preview.reason).toContain('is not a usable git ref')
    expect(preview.reason).toContain('--all')
  })

  it('says so when the two sides share no history at all', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '--orphan', 'stranger'])
    await repo.git(['rm', '-rq', '--cached', '.'])
    await repo.write('alone.txt', 'nothing in common\n')
    await repo.commit('unrelated root')
    await repo.git(['checkout', '-q', 'main'])

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'stranger'
    })

    expect(preview.state).toBe('unrelated')
    expect(preview.reason).toContain('share no history')
  })

  // git cannot tell these two apart, and neither should the report.
  it('says there is nothing to merge for a branch that never diverged', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.git(['checkout', '-q', 'main'])

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('nothingToMerge')
    expect(preview.ahead).toBe(0)
  })

  it('says the same once the branch has been merged in', async () => {
    const repo = await repository()
    await branch(repo, 'feature', 'only-here.txt', 'work\n')
    await repo.git(['merge', '--no-edit', '-q', 'feature'])

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('nothingToMerge')
  })

  it('counts what a diverged branch is carrying', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.write('one.txt', 'a\n')
    await repo.commit('one')
    await repo.write('two.txt', 'b\n')
    await repo.commit('two')
    await repo.git(['checkout', '-q', 'main'])

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('clean')
    expect(preview.ahead).toBe(2)
  })

  it('is clean for a branch that is merely behind', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('ahead.txt', 'main moved\n')
    await repo.commit('main moves on')

    const preview = await readMergePreview(repo.runner, {
      worktreeId: 'wt',
      repoPath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature'
    })

    expect(preview.state).toBe('nothingToMerge')
  })
})
