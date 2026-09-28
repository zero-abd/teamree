import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { createTempRepo, type TempRepo } from './testRepository'
import { commitWorktree } from './worktreeCommit'

describe('committing in a worktree', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  const commit = async (
    repo: TempRepo,
    options: { message?: string; paths?: string[]; all?: boolean; amend?: boolean; linkedPaths?: string[] } = {}
  ): ReturnType<typeof commitWorktree> =>
    commitWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      message: options.message ?? 'a message',
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      ...(options.all === undefined ? {} : { all: options.all }),
      ...(options.amend === undefined ? {} : { amend: options.amend }),
      ...(options.linkedPaths === undefined ? {} : { prepared: { linkedPaths: options.linkedPaths } }),
      now: () => 4242
    })

  it('stages the paths it is given and commits exactly those', async () => {
    const repo = await repository()
    await repo.write('wanted.ts', 'export const a = 1\n')
    await repo.write('not-wanted.log', 'noise\n')

    const result = await commit(repo, { message: 'add the thing', paths: ['wanted.ts'] })

    expect(result.paths).toEqual(['wanted.ts'])
    expect(result.message).toBe('add the thing')
    expect(result.shortSha).toBe(result.sha.slice(0, 7))
    expect(result.committedAt).toBe(4242)
    expect(await repo.git(['show', '--name-only', '--format=', 'HEAD'])).toBe('wanted.ts')
    // The file nobody named is still sitting there untracked.
    expect(await repo.git(['status', '--porcelain'])).toContain('not-wanted.log')
  })

  it('commits what was already staged when no paths are named', async () => {
    const repo = await repository()
    await repo.write('staged.ts', 'export const a = 1\n')
    await repo.write('loose.ts', 'export const b = 2\n')
    await repo.git(['add', 'staged.ts'])

    const result = await commit(repo)

    expect(result.paths).toEqual(['staged.ts'])
    expect(await repo.git(['status', '--porcelain'])).toContain('loose.ts')
  })

  it('commits a partly staged file as the index holds it, leaving the rest unstaged', async () => {
    const repo = await repository()
    await repo.write('two.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n')
    await repo.commit('add two')
    await repo.write('two.txt', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n')
    const top = (await repo.git(['diff', '-U0', '--', 'two.txt'])).split('\n@@ -10')[0]!
    await repo.runner.run({ args: ['apply', '--cached', '--unidiff-zero', '-'], cwd: repo.repoPath, stdin: `${top}\n` })

    const result = await commit(repo)

    expect(result.paths).toEqual(['two.txt'])
    expect(await repo.git(['show', 'HEAD:two.txt'])).toBe('A\nb\nc\nd\ne\nf\ng\nh\ni\nj')
    expect(await repo.git(['diff', '--no-color', '-U0'])).toContain('+J')
  })

  // The report has to describe the commit, not the request: a path staged
  // earlier rides along, and pretending otherwise is a lie about the history.
  it('reports everything the commit captured, not only what was asked for', async () => {
    const repo = await repository()
    await repo.write('earlier.ts', 'export const a = 1\n')
    await repo.git(['add', 'earlier.ts'])
    await repo.write('now.ts', 'export const b = 2\n')

    const result = await commit(repo, { paths: ['now.ts'] })

    expect(result.paths).toEqual(['earlier.ts', 'now.ts'])
  })

  it('refuses when nothing is staged and nothing was named', async () => {
    const repo = await repository()
    await repo.write('untouched-by-git.ts', 'export const a = 1\n')

    await expect(commit(repo)).rejects.toThrow(/nothing is staged/i)
  })

  it('refuses when the paths named have nothing to commit', async () => {
    const repo = await repository()
    await repo.write('tracked.ts', 'export const a = 1\n')
    await repo.commit('add tracked')

    await expect(commit(repo, { paths: ['tracked.ts'] })).rejects.toThrow(/nothing staged/i)
  })

  it('refuses an empty message rather than writing one', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'export const a = 1\n')

    await expect(commit(repo, { message: '   ', paths: ['a.ts'] })).rejects.toBeInstanceOf(GitServiceError)
  })

  // Committing a conflicted tree writes the conflict markers into the history
  // as if they were code, and it is the kind of mistake nobody notices for days.
  it('refuses a worktree with unresolved conflicts, and names them', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'one\ntwo\nthree\n')
    await repo.commit('add shared')
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('shared.txt', 'one\nFEATURE\nthree\n')
    await repo.commit('feature edit')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('shared.txt', 'one\nMAIN\nthree\n')
    await repo.commit('main edit')
    // Leaves the worktree mid-merge with a conflicted file, which is the state
    // under test.
    const merge = await repo.runner.tryRun({ args: ['merge', 'feature'], cwd: repo.repoPath })
    expect(merge.exitCode).not.toBe(0)

    await expect(commit(repo, { message: 'resolve it' })).rejects.toThrow(/shared\.txt/)
  })

  it('keeps a path that looks like a flag a path', async () => {
    const repo = await repository()
    await repo.write('--not-a-flag.txt', 'tricky\n')

    const result = await commit(repo, { paths: ['--not-a-flag.txt'] })

    expect(result.paths).toEqual(['--not-a-flag.txt'])
  })

  it('leaves the history alone when it refuses', async () => {
    const repo = await repository()
    const before = await repo.git(['rev-parse', 'HEAD'])

    await expect(commit(repo)).rejects.toThrow()

    expect(await repo.git(['rev-parse', 'HEAD'])).toBe(before)
  })

  // Past the Changes list's cap: every change goes in, not the rows on screen.
  it('commits every change with all, new files and deletions included, however many', async () => {
    const repo = await repository()
    const dirs = Array.from({ length: 20 }, (_, index) => `pkg${index}`)
    await Promise.all(dirs.map((dir) => mkdir(path.join(repo.repoPath, dir), { recursive: true })))
    const tracked = Array.from({ length: 1000 }, (_, index) => `${dirs[index % 20]}/t${index}.ts`)
    await Promise.all(tracked.map((file) => writeFile(path.join(repo.repoPath, file), 'a\n')))
    await repo.commit('tracked')
    await Promise.all(tracked.slice(0, 990).map((file) => writeFile(path.join(repo.repoPath, file), 'b\n')))
    await rm(path.join(repo.repoPath, tracked[995]!))
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) => writeFile(path.join(repo.repoPath, `fresh${index}.ts`), 'n\n'))
    )
    await repo.write('new-dir/deep/one.ts', 'n\n')

    const result = await commit(repo, { message: 'all of it', all: true })

    expect(await repo.git(['status', '--porcelain', '--untracked-files=all'])).toBe('')
    expect(result.paths).toHaveLength(990 + 1 + 1000 + 1)
    expect(await repo.git(['show', '--format=', '--name-only', 'HEAD'])).toContain('new-dir/deep/one.ts')
  })

  it('leaves what the project links into every worktree out of all', async () => {
    const repo = await repository()
    await repo.write('.gitignore', 'node_modules/\n')
    await repo.commit('ignore')
    await mkdir(path.join(repo.base, 'shared-modules'))
    await symlink(path.join(repo.base, 'shared-modules'), path.join(repo.repoPath, 'node_modules'))
    await repo.write('src/app.ts', 'x\n')

    const result = await commit(repo, { all: true, linkedPaths: ['node_modules'] })

    expect(result.paths).toEqual(['src/app.ts'])
    expect(await repo.git(['status', '--porcelain'])).toBe('?? node_modules')
  })

  it('refuses all with paths named', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'x\n')
    await expect(commit(repo, { all: true, paths: ['a.ts'] })).rejects.toBeInstanceOf(GitServiceError)
  })

  it('amends the last commit with what is staged and the new message, adding no commit', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'a\n')
    await repo.commit('first try')
    const count = await repo.git(['rev-list', '--count', 'HEAD'])
    await repo.write('b.ts', 'b\n')

    const result = await commit(repo, { message: 'the real subject', paths: ['b.ts'], amend: true })

    expect(await repo.git(['rev-list', '--count', 'HEAD'])).toBe(count)
    expect(await repo.git(['log', '-1', '--format=%s'])).toBe('the real subject')
    expect(await repo.git(['show', '--name-only', '--format=', 'HEAD'])).toContain('b.ts')
    expect(result.paths).toEqual(['b.ts'])
  })

  it('amends the message alone when nothing is staged', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'a\n')
    await repo.commit('typo in the subjcet')

    await commit(repo, { message: 'no typo in the subject', amend: true })

    expect(await repo.git(['log', '-1', '--format=%s'])).toBe('no typo in the subject')
    expect(await repo.git(['show', '--name-only', '--format=', 'HEAD'])).toBe('a.ts')
  })

  describe('a hook that refuses', () => {
    /** Installs `script` as `name` in a hooks folder of the repo's own, whatever ~/.gitconfig says. */
    const hook = async (repo: TempRepo, name: string, script: string): Promise<void> => {
      const hooks = path.join(repo.base, 'hooks')
      await mkdir(hooks, { recursive: true })
      await writeFile(path.join(hooks, name), `#!/bin/sh\n${script}\n`)
      await chmod(path.join(hooks, name), 0o755)
      await repo.git(['config', 'core.hooksPath', hooks])
    }
    const refusal = async (promise: Promise<unknown>): Promise<GitServiceError> => {
      const error = await promise.then(
        () => null,
        (thrown: unknown) => thrown
      )
      expect(error).toBeInstanceOf(GitServiceError)
      return error as GitServiceError
    }

    it('names the hook and returns every line it printed, stdout and stderr', async () => {
      const repo = await repository()
      await hook(
        repo,
        'pre-commit',
        [
          'echo "lint: 3 problems (2 errors, 1 warning)"',
          'echo "src/a.ts:1:7 error no-unused-vars"',
          'echo "src/b.ts:4:2 error no-undef" >&2',
          'echo "src/b.ts:9:1 warning eqeqeq"',
          'exit 1'
        ].join('\n')
      )
      await repo.write('a.ts', 'a\n')

      const error = await refusal(commit(repo, { all: true }))

      expect(error.message).toBe('pre-commit hook failed: lint: 3 problems (2 errors, 1 warning)')
      expect(error.data).toEqual({
        kind: 'hook',
        hook: 'pre-commit',
        output: [
          'lint: 3 problems (2 errors, 1 warning)',
          'src/a.ts:1:7 error no-unused-vars',
          'src/b.ts:4:2 error no-undef',
          'src/b.ts:9:1 warning eqeqeq'
        ].join('\n')
      })
      expect(await repo.git(['log', '--format=%s'])).toBe('initial commit')
    })

    it('says which hook it was when the message hook refuses', async () => {
      const repo = await repository()
      await hook(repo, 'commit-msg', 'echo "subject must be imperative"\nexit 1')
      await repo.write('a.ts', 'a\n')

      const error = await refusal(commit(repo, { all: true }))

      expect(error.data).toMatchObject({ kind: 'hook', hook: 'commit-msg', output: 'subject must be imperative' })
    })

    it('caps a long output, saying how much it left out', async () => {
      const repo = await repository()
      await hook(repo, 'pre-commit', 'i=1; while [ $i -le 450 ]; do echo "line $i"; i=$((i+1)); done; exit 1')
      await repo.write('a.ts', 'a\n')

      const error = await refusal(commit(repo, { all: true }))
      const lines = (error.data as { output: string }).output.split('\n')

      expect(lines).toHaveLength(201)
      expect(lines[0]).toBe('line 1')
      expect(lines[199]).toBe('line 200')
      expect(lines[200]).toBe('… 250 more lines')
    })

    it('commits when the hook passes', async () => {
      const repo = await repository()
      await hook(repo, 'pre-commit', 'echo checked; exit 0')
      await repo.write('a.ts', 'a\n')

      const result = await commit(repo, { all: true, message: 'passes' })

      expect(result.paths).toEqual(['a.ts'])
      expect(await repo.git(['log', '-1', '--format=%s'])).toBe('passes')
    })
  })
})
