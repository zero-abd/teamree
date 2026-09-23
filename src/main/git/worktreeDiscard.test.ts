// Real repositories and the real git: discarding is the one write here that
// destroys work, so each case checks the bytes on disk and in the index after.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parsePatch, type PatchHunk } from '../../shared/patch'
import { createTempRepo, type TempRepo } from './testRepository'
import { discardHunk, discardPath, type Trash } from './worktreeDiscard'
import { applyHunk } from './worktreeHunk'

/** Sixteen lines, so two edits at opposite ends fall into two hunks. */
const LINES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']
const ORIGINAL = `${LINES.join('\n')}\n`
const edited = (swap: Record<string, string>): string => `${LINES.map((line) => swap[line] ?? line).join('\n')}\n`

describe('discarding', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.write('f.txt', ORIGINAL)
    await repo.commit('add f')
    return repo
  }

  const read = (repo: TempRepo, file = 'f.txt'): Promise<string> => readFile(path.join(repo.repoPath, file), 'utf8')

  /** A stand-in for `shell.trashItem`: moves the file into a folder the test can look in. */
  const fakeTrash = (repo: TempRepo): { trash: Trash; trashed: string[]; dir: string } => {
    const dir = path.join(repo.base, 'Trash')
    const trashed: string[] = []
    return {
      dir,
      trashed,
      trash: async (absolute) => {
        trashed.push(absolute)
        await mkdir(dir, { recursive: true })
        await rename(absolute, path.join(dir, path.basename(absolute)))
      }
    }
  }

  const discard = (repo: TempRepo, file: string, trash?: Trash): ReturnType<typeof discardPath> =>
    discardPath(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: file,
      ...(trash === undefined ? {} : { trash }),
      now: () => 4242
    })

  const hunksOf = async (repo: TempRepo, staged = false): Promise<PatchHunk[]> => {
    const patch = await repo.git(['diff', '--no-color', '--unified=3', ...(staged ? ['--cached'] : [])])
    return parsePatch(`${patch}\n`)[0]?.hunks ?? []
  }

  const dropHunk = (repo: TempRepo, hunk: PatchHunk, file = 'f.txt'): ReturnType<typeof discardHunk> =>
    discardHunk(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath, path: file, hunk, now: () => 4242 })

  describe('a file', () => {
    it('puts a modified file back to what was committed', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B' }))

      const result = await discard(repo, 'f.txt')

      expect(result).toEqual({ worktreeId: 'wt', path: 'f.txt', outcome: 'restored', discardedAt: 4242 })
      expect(await read(repo)).toBe(ORIGINAL)
      expect(await repo.git(['status', '--porcelain'])).toBe('')
    })

    it('keeps what is staged and throws away only the edits made since', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B' }))
      await repo.git(['add', 'f.txt'])
      const stagedBefore = await repo.git(['diff', '--cached', '--no-color'])
      await repo.write('f.txt', edited({ b: 'B', n: 'N' }))

      await discard(repo, 'f.txt')

      expect(await repo.git(['diff', '--cached', '--no-color'])).toBe(stagedBefore)
      expect(await read(repo)).toBe(edited({ b: 'B' }))
      expect(await repo.git(['diff', '--no-color'])).toBe('')
    })

    it('refuses a file whose change is all staged, and leaves the index alone', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B' }))
      await repo.git(['add', 'f.txt'])

      await expect(discard(repo, 'f.txt')).rejects.toMatchObject({ code: 'conflict' })
      expect(await repo.git(['diff', '--cached', '--no-color'])).toContain('+B')
      expect(await read(repo)).toBe(edited({ b: 'B' }))
    })

    it('brings back a file deleted from the working tree', async () => {
      const repo = await repository()
      await unlink(path.join(repo.repoPath, 'f.txt'))

      await discard(repo, 'f.txt')

      expect(await read(repo)).toBe(ORIGINAL)
    })

    it('reads the path literally, so a name with a glob in it restores that file alone', async () => {
      const repo = await repository()
      await repo.write('*.txt', 'star\n')
      await repo.commit('add star')
      await repo.write('*.txt', 'STAR\n')
      await repo.write('f.txt', edited({ b: 'B' }))

      await discard(repo, '*.txt')

      expect(await read(repo, '*.txt')).toBe('star\n')
      expect(await read(repo)).toBe(edited({ b: 'B' }))
    })

    it('refuses a path that leaves the worktree', async () => {
      const repo = await repository()
      await expect(discard(repo, '../outside.txt')).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(discard(repo, path.join(repo.repoPath, 'f.txt'))).rejects.toMatchObject({
        code: 'invalid_params'
      })
    })

    it('refuses a path with nothing to discard', async () => {
      const repo = await repository()
      await expect(discard(repo, 'f.txt')).rejects.toMatchObject({ code: 'conflict' })
    })
  })

  describe('an untracked file', () => {
    it('goes to the Trash, whole, and git forgets it', async () => {
      const repo = await repository()
      await repo.write('notes/new.txt', 'keep me\n')
      const bin = fakeTrash(repo)

      const result = await discard(repo, 'notes/new.txt', bin.trash)

      expect(result.outcome).toBe('trashed')
      expect(bin.trashed).toEqual([path.join(repo.repoPath, 'notes/new.txt')])
      expect(await readFile(path.join(bin.dir, 'new.txt'), 'utf8')).toBe('keep me\n')
      expect(existsSync(path.join(repo.repoPath, 'notes/new.txt'))).toBe(false)
      expect(await repo.git(['status', '--porcelain'])).toBe('')
    })

    // No Trash means no discard: there is no fallback that deletes.
    it('stays where it is when this runtime has no Trash', async () => {
      const repo = await repository()
      await repo.write('new.txt', 'keep me\n')

      await expect(discard(repo, 'new.txt')).rejects.toMatchObject({ code: 'conflict' })
      expect(await read(repo, 'new.txt')).toBe('keep me\n')
    })

    it('trashes one file, never the folder named instead of it', async () => {
      const repo = await repository()
      await repo.write('notes/new.txt', 'keep me\n')
      const bin = fakeTrash(repo)

      await expect(discard(repo, 'notes', bin.trash)).rejects.toMatchObject({ code: 'conflict' })
      expect(bin.trashed).toEqual([])
      expect(await read(repo, 'notes/new.txt')).toBe('keep me\n')
    })

    // `git restore` would write the index's empty blob over it.
    it('refuses an intent-to-add file rather than emptying it', async () => {
      const repo = await repository()
      await repo.write('new.txt', 'keep me\n')
      await repo.git(['add', '--intent-to-add', 'new.txt'])
      const bin = fakeTrash(repo)

      await expect(discard(repo, 'new.txt', bin.trash)).rejects.toMatchObject({ code: 'conflict' })
      expect(bin.trashed).toEqual([])
      expect(await read(repo, 'new.txt')).toBe('keep me\n')
    })
  })

  describe('one hunk', () => {
    it('reverses exactly that hunk out of the file and leaves the other', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B', n: 'N' }))
      const hunks = await hunksOf(repo)
      expect(hunks).toHaveLength(2)

      const result = await dropHunk(repo, hunks[1] as PatchHunk)

      expect(result).toEqual({ worktreeId: 'wt', path: 'f.txt', outcome: 'hunk', discardedAt: 4242 })
      expect(await read(repo)).toBe(edited({ b: 'B' }))
      expect(await repo.git(['diff', '--cached', '--no-color'])).toBe('')
    })

    it('never touches the staged half of the same file', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B', n: 'N' }))
      await applyHunk(repo.runner, {
        worktreeId: 'wt',
        worktreePath: repo.repoPath,
        path: 'f.txt',
        hunk: (await hunksOf(repo))[0] as PatchHunk,
        staged: true
      })
      const stagedBefore = await repo.git(['diff', '--cached', '--no-color'])
      const left = await hunksOf(repo)
      expect(left).toHaveLength(1)

      await dropHunk(repo, left[0] as PatchHunk)

      expect(await repo.git(['diff', '--cached', '--no-color'])).toBe(stagedBefore)
      expect(await read(repo)).toBe(edited({ b: 'B' }))
      expect(await repo.git(['diff', '--no-color'])).toBe('')
    })

    it('refuses a hunk of the staged patch, and the file stays as it is', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B' }))
      await repo.git(['add', 'f.txt'])
      await repo.write('f.txt', edited({ b: 'B', n: 'N' }))
      const staged = (await hunksOf(repo, true))[0] as PatchHunk

      await expect(dropHunk(repo, staged)).rejects.toMatchObject({ code: 'conflict' })
      expect(await read(repo)).toBe(edited({ b: 'B', n: 'N' }))
      expect(await repo.git(['diff', '--cached', '--no-color'])).toContain('+B')
    })

    it('refuses a hunk read before the file moved on', async () => {
      const repo = await repository()
      await repo.write('f.txt', edited({ b: 'B', n: 'N' }))
      const hunk = (await hunksOf(repo))[1] as PatchHunk
      await repo.write('f.txt', edited({ b: 'B', n: 'ENTIRELY OTHER' }))

      await expect(dropHunk(repo, hunk)).rejects.toMatchObject({ code: 'conflict' })
      expect(await read(repo)).toBe(edited({ b: 'B', n: 'ENTIRELY OTHER' }))
    })

    it('refuses a hunk of an untracked file, whose whole content is the change', async () => {
      const repo = await repository()
      await repo.write('new.txt', 'x\ny\n')
      const hunk: PatchHunk = {
        header: '@@ -0,0 +1,2 @@',
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'added', text: 'x', oldNumber: null, newNumber: 1, noNewline: false },
          { kind: 'added', text: 'y', oldNumber: null, newNumber: 2, noNewline: false }
        ]
      } as PatchHunk

      await expect(dropHunk(repo, hunk, 'new.txt')).rejects.toMatchObject({ code: 'conflict' })
      expect(await read(repo, 'new.txt')).toBe('x\ny\n')
    })

    // `apply.whitespace=fix` would "fix" the lines a reverse puts back.
    it('puts back the committed bytes exactly, trailing spaces included', async () => {
      const repo = await repository()
      await repo.write('ws.txt', 'one  \ntwo\n')
      await repo.commit('trailing spaces')
      await repo.git(['config', 'apply.whitespace', 'fix'])
      await repo.write('ws.txt', 'ONE\ntwo\n')

      await dropHunk(repo, (await hunksOf(repo))[0] as PatchHunk, 'ws.txt')

      expect(await read(repo, 'ws.txt')).toBe('one  \ntwo\n')
    })
  })
})
