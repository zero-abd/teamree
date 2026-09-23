// Real repositories, real `git apply`, real index.
//
// A mocked runner here would prove that this file and `worktreeHunk.ts` agree
// about which flags to pass, which is the one thing that was never in doubt.
// What is in doubt is whether the patch that gets built out of a parsed hunk is
// one git will take, and whether the index afterwards holds exactly that hunk
// and nothing else — and only git can answer either.

import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePatch, type PatchHunk } from '../../shared/patch'
import { GitServiceError } from './errors'
import { createTempRepo, type TempRepo } from './testRepository'
import { applyHunk, hunkPatch } from './worktreeHunk'

/** Sixteen lines, so two edits at opposite ends fall into two hunks. */
const LINES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']

describe('staging one hunk', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  /** A committed file, then two edits in it far enough apart to be two hunks. */
  const twoHunks = async (): Promise<TempRepo> => {
    const repo = await repository()
    await repo.write('f.txt', `${LINES.join('\n')}\n`)
    await repo.commit('add f')
    await repo.write('f.txt', `${LINES.map((line) => (line === 'b' ? 'B' : line === 'n' ? 'N' : line)).join('\n')}\n`)
    return repo
  }

  /** The hunks git reports right now, parsed the way the panel parses them. */
  const hunksOf = async (repo: TempRepo, staged = false): Promise<PatchHunk[]> => {
    const patch = await repo.git(['diff', '--no-color', '--unified=3', ...(staged ? ['--cached'] : [])])
    const files = parsePatch(`${patch}\n`)
    return files[0]?.hunks ?? []
  }

  const stage = async (
    repo: TempRepo,
    hunk: PatchHunk,
    staged: boolean,
    file = 'f.txt'
  ): ReturnType<typeof applyHunk> =>
    applyHunk(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: file,
      hunk,
      staged,
      now: () => 4242
    })

  it('puts exactly the hunk it was given into the index and leaves the other one out', async () => {
    const repo = await twoHunks()
    const hunks = await hunksOf(repo)
    expect(hunks).toHaveLength(2)

    const result = await stage(repo, hunks[1] as PatchHunk, true)

    expect(result).toMatchObject({ worktreeId: 'wt', path: 'f.txt', staged: true, added: 1, removed: 1 })
    expect(result.appliedAt).toBe(4242)
    // The index holds the second edit.
    expect(await repo.git(['diff', '--cached', '--no-color'])).toContain('+N')
    expect(await repo.git(['diff', '--cached', '--no-color'])).not.toContain('+B')
    // The working tree still holds the first one, unstaged.
    expect(await repo.git(['diff', '--no-color'])).toContain('+B')
    expect(await repo.git(['diff', '--no-color'])).not.toContain('+N')
  })

  // The whole point of `--cached`: the file on disk is what somebody has open.
  it('never touches the working tree', async () => {
    const repo = await twoHunks()
    const before = await readFile(path.join(repo.repoPath, 'f.txt'), 'utf8')

    await stage(repo, (await hunksOf(repo))[0] as PatchHunk, true)

    expect(await readFile(path.join(repo.repoPath, 'f.txt'), 'utf8')).toBe(before)
  })

  it('takes a staged hunk back out again', async () => {
    const repo = await twoHunks()
    await stage(repo, (await hunksOf(repo))[1] as PatchHunk, true)

    const staged = await hunksOf(repo, true)
    expect(staged).toHaveLength(1)
    const result = await stage(repo, staged[0] as PatchHunk, false)

    expect(result.staged).toBe(false)
    expect(await repo.git(['diff', '--cached', '--no-color'])).toBe('')
    // And the change is back where it started: pending in the working tree.
    const pending = await repo.git(['diff', '--no-color'])
    expect(pending).toContain('+B')
    expect(pending).toContain('+N')
  })

  it('stages the two hunks of one file separately, without either disturbing the other', async () => {
    const repo = await twoHunks()
    await stage(repo, (await hunksOf(repo))[0] as PatchHunk, true)
    const left = await hunksOf(repo)
    expect(left).toHaveLength(1)

    await stage(repo, left[0] as PatchHunk, true)

    expect(await repo.git(['diff', '--no-color'])).toBe('')
    const cached = await repo.git(['diff', '--cached', '--no-color'])
    expect(cached).toContain('+B')
    expect(cached).toContain('+N')
  })

  // The refusal this feature exists to make. `git apply --cached` compares the
  // hunk against the index, which nobody edited, so it would happily stage a
  // patch read before the last four saves.
  it('refuses a hunk whose file has moved on, and leaves the index alone', async () => {
    const repo = await twoHunks()
    const hunk = (await hunksOf(repo))[1] as PatchHunk

    await writeFile(
      path.join(repo.repoPath, 'f.txt'),
      `${LINES.map((line) => (line === 'b' ? 'B' : line === 'n' ? 'ENTIRELY OTHER' : line)).join('\n')}\n`,
      'utf8'
    )

    await expect(stage(repo, hunk, true)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('changed since that patch was read')
    })
    expect(await repo.git(['diff', '--cached', '--no-color'])).toBe('')
  })

  it('refuses a hunk that is no longer staged', async () => {
    const repo = await twoHunks()
    await stage(repo, (await hunksOf(repo))[1] as PatchHunk, true)
    const staged = (await hunksOf(repo, true))[0] as PatchHunk
    await repo.git(['reset', '--quiet'])

    await expect(stage(repo, staged, false)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses an untracked file, whose whole content is one hunk anyway', async () => {
    const repo = await repository()
    await repo.write('new.txt', 'x\ny\n')
    const attempt = applyHunk(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'new.txt',
      hunk: {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'added', text: 'x' },
          { kind: 'added', text: 'y' }
        ]
      },
      staged: true
    })

    await expect(attempt).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('stage the file rather than a hunk')
    })
    // Refused before anything was written: git still has never heard of it.
    expect(await repo.git(['diff', '--cached', '--name-only'])).toBe('')
  })

  it('refuses a hunk that does not add up to its own header', async () => {
    const repo = await twoHunks()
    const hunk = (await hunksOf(repo))[0] as PatchHunk
    const cutShort = { ...hunk, lines: hunk.lines.slice(0, 2) }

    await expect(stage(repo, cutShort, true)).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('incomplete')
    })
  })

  it('refuses a path a patch cannot name', async () => {
    const repo = await twoHunks()
    const hunk = (await hunksOf(repo))[0] as PatchHunk
    const attempt = applyHunk(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: 'has\ttab.txt',
      hunk,
      staged: true
    })
    await expect(attempt).rejects.toBeInstanceOf(GitServiceError)
  })

  it('stages a hunk of a file whose name has a space and a non-ASCII byte in it', async () => {
    const repo = await repository()
    const name = 'a dir/héllo ünï.txt'
    await repo.write(name, `${LINES.join('\n')}\n`)
    await repo.commit('add it')
    await repo.write(name, `${LINES.map((line) => (line === 'b' ? 'B' : line)).join('\n')}\n`)

    const parsed = parsePatch(`${await repo.git(['diff', '--no-color', '--unified=3'])}\n`)
    const hunk = parsed[0]?.hunks[0] as PatchHunk
    await applyHunk(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      path: name,
      hunk,
      staged: true
    })

    // `core.quotePath=false` so the comparison is against the name rather than
    // against git's C-escaped rendering of it.
    expect(await repo.git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only'])).toBe(name)
  })

  it('keeps the no-newline remark attached to the line it is about', async () => {
    const repo = await repository()
    await repo.write('tail.txt', 'one\ntwo\nthree')
    await repo.commit('no trailing newline')
    await repo.write('tail.txt', 'one\ntwo\nthree\n')

    const hunk = (await hunksOf(repo))[0] as PatchHunk
    expect(hunkPatch('tail.txt', hunk)).toContain('\\ No newline at end of file')

    await stage(repo, hunk, true, 'tail.txt')
    expect(await repo.git(['diff', '--cached', '--no-color'])).toContain('\\ No newline at end of file')
  })

  it('writes a header whose counts come from the lines rather than from the caller', () => {
    const patch = hunkPatch('f.txt', {
      oldStart: 11,
      oldCount: 6,
      newStart: 11,
      newCount: 6,
      lines: [
        { kind: 'context', text: 'k' },
        { kind: 'context', text: 'l' },
        { kind: 'context', text: 'm' },
        { kind: 'removed', text: 'n' },
        { kind: 'added', text: 'N' },
        { kind: 'context', text: 'o' },
        { kind: 'context', text: 'p' }
      ]
    })
    expect(patch).toContain('@@ -11,6 +11,6 @@')
    expect(patch.startsWith('diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n')).toBe(true)
  })
})
