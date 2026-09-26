import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { fetchBase } from './baseFetch'
import { createTempRepo, type TempRepo } from './testRepository'
import { readWorktreeChanges } from './worktreeChanges'
import { abortWorktreeUpdate, continueWorktreeUpdate, resolveWorktreeConflict, updateWorktree } from './worktreeUpdate'
import { readOperation, readWorktreeStatus } from './worktreeStatus'

let repo: TempRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

/** A repo with a bare origin, a worktree `work` cut from origin/main, and a teammate's clone. */
async function setUp(): Promise<{ repo: TempRepo; worktree: string; teammate: string }> {
  const made = await createTempRepo({ withRemote: true })
  repo = made
  await made.write('src/math.ts', 'export const add = 1\n')
  await made.commit('Add math')
  await made.git(['push', 'origin', 'main'])
  await made.git(['fetch', 'origin'])
  const worktree = path.join(made.base, 'worktrees', 'work')
  await made.git(['worktree', 'add', '--no-track', '-b', 'work', worktree, 'origin/main'])
  const teammate = path.join(made.base, 'teammate')
  await made.git(['clone', path.join(made.base, 'origin.git'), teammate], made.base)
  await made.git(['config', 'user.name', 'Teammate'], teammate)
  await made.git(['config', 'user.email', 'mate@teamree.invalid'], teammate)
  await made.git(['config', 'commit.gpgsign', 'false'], teammate)
  return { repo: made, worktree, teammate }
}

async function teammatePushes(made: TempRepo, teammate: string, file: string, content: string): Promise<void> {
  await made.write(file, content, teammate)
  await made.commit(`Teammate edits ${file}`, teammate)
  await made.git(['push', 'origin', 'main'], teammate)
}

async function status(made: TempRepo, worktree: string) {
  return readWorktreeStatus(made.runner, {
    worktreeId: 'w1',
    worktreePath: worktree,
    fallbackBranch: 'work',
    baseRef: 'origin/main'
  })
}

describe('fetchBase', () => {
  it('moves the base ref after a teammate pushes, so the worktree reads one behind', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await teammatePushes(made, teammate, 'NOTES.md', 'hello\n')
    expect((await status(made, worktree)).behind).toBe(0)

    expect(await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })).toBe('moved')
    expect((await status(made, worktree)).behind).toBe(1)
    expect(await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })).toBe('unchanged')
  })

  it('skips a base that is not on a remote', async () => {
    const { repo: made } = await setUp()
    expect(await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'main' })).toBe('skipped')
  })
})

describe('updateWorktree', () => {
  it('rebases an unpublished branch onto the moved base', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await made.write('src/sub.ts', 'export const sub = 1\n', worktree)
    await made.commit('Add sub', worktree)
    await teammatePushes(made, teammate, 'NOTES.md', 'hello\n')
    await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })

    const result = await updateWorktree(made.runner, {
      worktreeId: 'w1',
      worktreePath: worktree,
      baseRef: 'origin/main'
    })

    expect(result).toMatchObject({ mode: 'rebase', outcome: 'updated', conflicts: [] })
    const after = await status(made, worktree)
    expect(after).toMatchObject({ behind: 0, ahead: 1 })
    // Linear: the branch's one commit sits directly on the new base.
    expect(await made.git(['rev-parse', 'HEAD~1'], worktree)).toBe(await made.git(['rev-parse', 'origin/main']))
  })

  it('merges the base into a published branch', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await made.write('src/sub.ts', 'export const sub = 1\n', worktree)
    await made.commit('Add sub', worktree)
    await made.git(['push', '-u', 'origin', 'work'], worktree)
    await teammatePushes(made, teammate, 'NOTES.md', 'hello\n')
    await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })

    const result = await updateWorktree(made.runner, {
      worktreeId: 'w1',
      worktreePath: worktree,
      baseRef: 'origin/main'
    })

    expect(result).toMatchObject({ mode: 'merge', outcome: 'updated' })
    expect((await made.git(['rev-list', '--parents', '-n', '1', 'HEAD'], worktree)).split(' ')).toHaveLength(3)
    expect((await status(made, worktree)).behind).toBe(0)
  })

  it('says so and does nothing when the base has not moved', async () => {
    const { repo: made, worktree } = await setUp()
    const head = await made.git(['rev-parse', 'HEAD'], worktree)
    const result = await updateWorktree(made.runner, {
      worktreeId: 'w1',
      worktreePath: worktree,
      baseRef: 'origin/main'
    })
    expect(result.outcome).toBe('upToDate')
    expect(await made.git(['rev-parse', 'HEAD'], worktree)).toBe(head)
  })

  it('refuses in one line while there is uncommitted work', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await teammatePushes(made, teammate, 'NOTES.md', 'hello\n')
    await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })
    await made.write('src/math.ts', 'export const add = 2\n', worktree)

    const refused = updateWorktree(made.runner, { worktreeId: 'w1', worktreePath: worktree, baseRef: 'origin/main' })
    await expect(refused).rejects.toBeInstanceOf(GitServiceError)
    await expect(refused).rejects.toThrow(/^Commit or stash first$/)
  })

  it('stops on a conflict with the files listed, and abort puts the branch back', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await made.write('src/math.ts', 'export const add = 1\nexport const sub = 2\n', worktree)
    await made.commit('Add sub', worktree)
    const before = await made.git(['rev-parse', 'HEAD'], worktree)
    await teammatePushes(made, teammate, 'src/math.ts', 'export const add = 1\nexport const div = 3\n')
    await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })

    const result = await updateWorktree(made.runner, {
      worktreeId: 'w1',
      worktreePath: worktree,
      baseRef: 'origin/main'
    })

    expect(result).toMatchObject({ mode: 'rebase', outcome: 'conflicts', conflicts: ['src/math.ts'] })
    expect(readOperation(worktree)).toBe('rebase')
    expect(await status(made, worktree)).toMatchObject({ conflicted: 1, operation: 'rebase' })

    expect(await abortWorktreeUpdate(made.runner, { worktreeId: 'w1', worktreePath: worktree })).toEqual({
      worktreeId: 'w1',
      aborted: 'rebase'
    })
    expect(readOperation(worktree)).toBeUndefined()
    expect(await made.git(['rev-parse', 'HEAD'], worktree)).toBe(before)
    const after = await status(made, worktree)
    expect(after.conflicted).toBe(0)
    expect(after.operation).toBeUndefined()
  })

  it('stops a merge on a conflict too, and abort undoes it', async () => {
    const { repo: made, worktree, teammate } = await setUp()
    await made.write('src/math.ts', 'export const add = 1\nexport const sub = 2\n', worktree)
    await made.commit('Add sub', worktree)
    await made.git(['push', '-u', 'origin', 'work'], worktree)
    const before = await made.git(['rev-parse', 'HEAD'], worktree)
    await teammatePushes(made, teammate, 'src/math.ts', 'export const add = 1\nexport const div = 3\n')
    await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })

    const result = await updateWorktree(made.runner, {
      worktreeId: 'w1',
      worktreePath: worktree,
      baseRef: 'origin/main'
    })

    expect(result).toMatchObject({ mode: 'merge', outcome: 'conflicts', conflicts: ['src/math.ts'] })
    expect(readOperation(worktree)).toBe('merge')
    await expect(
      updateWorktree(made.runner, { worktreeId: 'w1', worktreePath: worktree, baseRef: 'origin/main' })
    ).rejects.toThrow(/in progress/)

    expect((await abortWorktreeUpdate(made.runner, { worktreeId: 'w1', worktreePath: worktree })).aborted).toBe('merge')
    expect(await made.git(['rev-parse', 'HEAD'], worktree)).toBe(before)
    expect(readOperation(worktree)).toBeUndefined()
  })

  it('aborts nothing when nothing is in progress', async () => {
    const { repo: made, worktree } = await setUp()
    expect((await abortWorktreeUpdate(made.runner, { worktreeId: 'w1', worktreePath: worktree })).aborted).toBeNull()
  })
})

/** The worktree's branch and origin/main each rewrote the one line after `add`; `publish` makes the update a merge. */
async function conflicting(publish: boolean, commits = 1): Promise<{ made: TempRepo; worktree: string }> {
  const { repo: made, worktree, teammate } = await setUp()
  for (let at = 1; at <= commits; at += 1) {
    await made.write('src/math.ts', `export const add = 1\nexport const sub = ${at + 1}\n`, worktree)
    await made.commit(`Add sub ${at}`, worktree)
  }
  if (publish) await made.git(['push', '-u', 'origin', 'work'], worktree)
  await teammatePushes(made, teammate, 'src/math.ts', 'export const add = 1\nexport const div = 3\n')
  await fetchBase(made.runner, { repoPath: made.repoPath, baseRef: 'origin/main' })
  const stopped = await updateWorktree(made.runner, {
    worktreeId: 'w1',
    worktreePath: worktree,
    baseRef: 'origin/main'
  })
  expect(stopped.outcome).toBe('conflicts')
  return { made, worktree }
}

const at = (made: TempRepo, worktree: string) => ({ worktreeId: 'w1', worktreePath: worktree, baseRef: 'origin/main' })
const conflictedRows = async (made: TempRepo, worktree: string) =>
  (await readWorktreeChanges(made.runner, { worktreeId: 'w1', worktreePath: worktree })).changes.filter(
    (change) => change.kind === 'conflicted'
  )

describe('a stopped update', () => {
  it('lists each conflicted file with the blocks its markers still hold', async () => {
    const { made, worktree } = await conflicting(true)
    expect(await conflictedRows(made, worktree)).toEqual([expect.objectContaining({ path: 'src/math.ts', markers: 1 })])
    await made.write('src/math.ts', 'export const add = 1\nexport const sub = 2\nexport const div = 3\n', worktree)
    expect(await conflictedRows(made, worktree)).toEqual([expect.objectContaining({ path: 'src/math.ts', markers: 0 })])
  })

  it('marks a hand-fixed file resolved, refuses Continue before that, and commits the merge after', async () => {
    const { made, worktree } = await conflicting(true)
    await expect(continueWorktreeUpdate(made.runner, at(made, worktree))).rejects.toThrow(
      /^Resolve src\/math.ts first$/
    )
    await made.write('src/math.ts', 'export const add = 1\nexport const sub = 2\nexport const div = 3\n', worktree)

    expect(await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts' })).toEqual({
      worktreeId: 'w1',
      conflicts: []
    })
    const done = await continueWorktreeUpdate(made.runner, at(made, worktree))
    expect(done).toMatchObject({ mode: 'merge', outcome: 'updated', conflicts: [] })
    expect(readOperation(worktree)).toBeUndefined()
    expect((await made.git(['rev-list', '--parents', '-n', '1', 'HEAD'], worktree)).split(' ')).toHaveLength(3)
    expect(await status(made, worktree)).toMatchObject({ behind: 0, conflicted: 0, staged: 0 })
  })

  it("takes this task's side or the base's in a merge", async () => {
    const { made, worktree } = await conflicting(true)
    await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts', take: 'ours' })
    expect(await readFile(path.join(worktree, 'src/math.ts'), 'utf8')).toBe(
      'export const add = 1\nexport const sub = 2\n'
    )
    await abortWorktreeUpdate(made.runner, { worktreeId: 'w1', worktreePath: worktree })

    await updateWorktree(made.runner, at(made, worktree))
    await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts', take: 'theirs' })
    expect(await readFile(path.join(worktree, 'src/math.ts'), 'utf8')).toBe(
      'export const add = 1\nexport const div = 3\n'
    )
    expect(await conflictedRows(made, worktree)).toEqual([])
  })

  it('keeps ours meaning this task in a rebase, where git swaps the sides', async () => {
    const { made, worktree } = await conflicting(false)
    expect(readOperation(worktree)).toBe('rebase')
    await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts', take: 'ours' })
    expect(await readFile(path.join(worktree, 'src/math.ts'), 'utf8')).toBe(
      'export const add = 1\nexport const sub = 2\n'
    )
    const done = await continueWorktreeUpdate(made.runner, at(made, worktree))
    expect(done).toMatchObject({ mode: 'rebase', outcome: 'updated' })
    expect(await made.git(['rev-parse', 'HEAD~1'], worktree)).toBe(await made.git(['rev-parse', 'origin/main']))
    expect(await made.git(['log', '-1', '--format=%s'], worktree)).toBe('Add sub 1')
  })

  it('continues a rebase commit by commit, stopping again on the next conflict, and skips one left empty', async () => {
    const { made, worktree } = await conflicting(false, 2)
    await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts', take: 'theirs' })
    // Taking the base's side leaves the first commit with nothing: skipped, not refused.
    const next = await continueWorktreeUpdate(made.runner, at(made, worktree))
    expect(next).toMatchObject({ mode: 'rebase', outcome: 'conflicts', conflicts: ['src/math.ts'] })
    expect(readOperation(worktree)).toBe('rebase')

    await resolveWorktreeConflict(made.runner, { ...at(made, worktree), path: 'src/math.ts', take: 'ours' })
    expect(await continueWorktreeUpdate(made.runner, at(made, worktree))).toMatchObject({ outcome: 'updated' })
    expect(readOperation(worktree)).toBeUndefined()
    expect(await made.git(['log', '--format=%s', '-2'], worktree)).toBe('Add sub 2\nTeammate edits src/math.ts')
  })

  it('refuses Continue with nothing in progress', async () => {
    const { repo: made, worktree } = await setUp()
    await expect(continueWorktreeUpdate(made.runner, at(made, worktree))).rejects.toThrow(/^Nothing to continue$/)
  })
})
