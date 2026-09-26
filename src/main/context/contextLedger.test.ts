// The ledger against real git: sibling worktrees in a throwaway repository,
// merged and landed the way a person would, read through the service.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { ContextLedger } from './contextLedger'

let repo: TempRepo
let dataDir: string
let project: Project
let worktrees: Worktree[]
let ledger: ContextLedger

async function addWorktree(id: string, task: string, parentId?: string): Promise<Worktree> {
  const checkout = path.join(repo.worktreesRoot, id)
  const from = parentId === undefined ? 'main' : (worktrees.find((row) => row.id === parentId)?.branch ?? 'main')
  await repo.git(['worktree', 'add', '-b', id, checkout, from])
  const worktree: Worktree = {
    id,
    projectId: project.id,
    name: id,
    branch: id,
    path: checkout,
    startedFrom: from,
    state: 'ready',
    createdAt: 1,
    task,
    ...(parentId === undefined ? {} : { parentId })
  }
  worktrees.push(worktree)
  return worktree
}

function open(options: { maxMergeTreesPerPass?: number } = {}): ContextLedger {
  return new ContextLedger({
    dataDir,
    runner: repo.runner,
    snapshot: () => ({ projects: [project], worktrees }),
    ...options
  })
}

const edit = async (worktree: Worktree, line: string, file = 'src/shared.ts'): Promise<void> => {
  await repo.write(file, `line one\n${line}\nline three\n`, worktree.path)
}

beforeEach(async () => {
  repo = await createTempRepo()
  dataDir = await mkdtemp(path.join(tmpdir(), 'teamree-ledger-data-'))
  await repo.write('src/shared.ts', 'line one\nline two\nline three\n')
  await repo.commit('shared file')
  project = { id: 'p1', name: 'repo', path: repo.repoPath, baseRef: 'main' }
  worktrees = []
  ledger = open()
})

afterEach(async () => {
  await ledger.close()
  await repo.cleanup()
  await rm(dataDir, { recursive: true, force: true })
})

describe('the coordination ledger', () => {
  it('flags a real conflict between two siblings changing the same line', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await edit(b, 'line two from b')
    await repo.commit('b edits', b.path)

    await ledger.refresh()
    const { overlaps } = await ledger.overlaps('p1')
    expect(overlaps).toContainEqual(
      expect.objectContaining({
        worktreeId: 'a',
        with: { worktreeId: 'b' },
        paths: ['src/shared.ts'],
        conflicts: ['src/shared.ts']
      })
    )
    expect(await ledger.conflicts('a')).toEqual([
      { worktreeId: 'b', owner: 'me', files: ['src/shared.ts'], conflicts: ['src/shared.ts'] }
    ])
    const context = await ledger.context({ worktreeId: 'a' })
    expect(context.text).toBe(
      ['goal: Add rate limits', 'sibling b: Fix login redirect', '  conflict: src/shared.ts'].join('\n')
    )
  })

  it('keeps an overlap that merges cleanly as an overlap, not a conflict', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('src/shared.ts', 'line one from a\nline two\nline three\n', a.path)
    await repo.commit('a edits', a.path)
    await repo.write('src/shared.ts', 'line one\nline two\nline three from b\n', b.path)
    await repo.commit('b edits', b.path)
    // Uncommitted work counts as touched, too.
    await repo.write('src/extra.ts', 'x\n', a.path)
    await repo.write('src/extra.ts', 'y\n', b.path)

    await ledger.refresh()
    const [overlap] = (await ledger.overlaps('p1')).overlaps
    expect(overlap).toMatchObject({ paths: ['src/extra.ts', 'src/shared.ts'], conflicts: [] })
    expect((await ledger.context({ worktreeId: 'b' })).text).toContain('  overlap: src/extra.ts, src/shared.ts')
  })

  it('answers empty when nothing overlaps', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('src/a.ts', 'a\n', a.path)
    await repo.write('src/b.ts', 'b\n', b.path)
    await ledger.refresh()
    const context = await ledger.context({ worktreeId: 'a' })
    expect(context.text).toBe('')
    expect(context.siblings).toEqual([])
    expect((await ledger.overlaps('p1')).overlaps).toEqual([])
  })

  it('tells a worktree about a sibling working inside its claim', async () => {
    await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    expect(await ledger.claim({ worktreeId: 'a', globs: ['src/limiter/**'] })).toEqual({
      worktreeId: 'a',
      globs: ['src/limiter/**']
    })
    await repo.write('src/limiter/index.ts', 'x\n', b.path)
    await ledger.refresh()
    expect((await ledger.context({ worktreeId: 'a' })).text).toBe(
      [
        'goal: Add rate limits',
        'claims: src/limiter/**',
        'sibling b: Fix login redirect',
        '  claimed: src/limiter/index.ts'
      ].join('\n')
    )
    expect((await ledger.unclaim({ worktreeId: 'a' })).globs).toEqual([])
  })

  it('expires a decision when its worktree lands, and logs the landing', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await repo.write('src/shared.ts', 'line one\nline two\nline three from b\n', b.path)
    await ledger.refresh()
    await ledger.note({ worktreeId: 'a', kind: 'decision', text: 'shared.ts stays pure', paths: ['src/shared.ts'] })
    expect((await ledger.context({ worktreeId: 'a' })).siblings.map((row) => row.worktreeId)).toEqual(['b'])
    expect((await ledger.context({ worktreeId: 'b' })).text).toContain(
      '  decision: shared.ts stays pure (src/shared.ts)'
    )

    await repo.git(['merge', '--no-ff', '-m', 'land a', 'a'])
    await ledger.refresh()

    const context = await ledger.context({ worktreeId: 'b' })
    expect(context.text).toBe('')
    expect((await ledger.inspect('p1')).landings).toEqual([
      expect.objectContaining({
        worktreeId: 'a',
        into: 'main',
        conflicts: [],
        shared: ['src/shared.ts'],
        warnings: [expect.objectContaining({ path: 'src/shared.ts', with: 'b', heeded: null })]
      })
    ])
  })

  it('records the conflicts a landing merge had to resolve', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await edit(b, 'line two from b')
    await repo.commit('b edits', b.path)
    await ledger.refresh()

    await repo.git(['merge', '--ff-only', 'a'])
    await repo.runner.tryRun({ args: ['merge', '--no-ff', '-m', 'land b', 'b'], cwd: repo.repoPath })
    await edit({ path: repo.repoPath } as Worktree, 'line two from both')
    await repo.commit('land b')
    await ledger.refresh()

    const landed = (await ledger.inspect('p1')).landings
    expect(landed.find((row) => row.worktreeId === 'a')?.conflicts).toEqual([])
    expect(landed.find((row) => row.worktreeId === 'b')?.conflicts).toEqual(['src/shared.ts'])
  })

  it('never compares a child with its parent', async () => {
    const parent = await addWorktree('p', 'Rework the API')
    await edit(parent, 'line two from parent')
    await repo.commit('parent edits', parent.path)
    const child = await addWorktree('c', 'Split the auth routes', 'p')
    await edit(child, 'line two from child')
    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps).toEqual([])
    expect((await ledger.context({ worktreeId: 'c' })).text).toBe('')

    // Moved back to the top level, it is a sibling of its old parent.
    delete child.parentId
    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps.map((row) => row.worktreeId).sort()).toEqual(['c', 'p'])
  })

  it('logs a child landing in its parent, with main untouched', async () => {
    const parent = await addWorktree('p', 'Rework the API')
    await edit(parent, 'line two from parent')
    await repo.commit('parent edits', parent.path)
    const child = await addWorktree('c', 'Split the auth routes', 'p')
    await repo.write('src/routes.ts', 'routes\n', child.path)
    await repo.commit('child routes', child.path)
    await ledger.refresh()

    await repo.git(['merge', '--no-ff', '-m', 'land c', 'c'], parent.path)
    await ledger.refresh()

    expect((await ledger.inspect('p1')).landings).toEqual([
      expect.objectContaining({ worktreeId: 'c', into: 'p', conflicts: [] })
    ])
    expect((await ledger.inspect('p1')).worktrees.find((row) => row.id === 'p')?.state).toBe('ready')
  })

  it('runs merge-tree at most so many times a pass, and never twice for the same two commits', async () => {
    ledger = open({ maxMergeTreesPerPass: 1 })
    for (const id of ['a', 'b', 'c']) {
      const worktree = await addWorktree(id, `task ${id}`)
      await edit(worktree, `line two from ${id}`)
      await repo.commit(`${id} edits`, worktree.path)
    }
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(1)
    await ledger.refresh()
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(3)
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(3)
    expect((await ledger.conflicts('a')).map((row) => row.conflicts)).toEqual([['src/shared.ts'], ['src/shared.ts']])
  })

  it('keeps claims, notes and touched paths across a restart', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    await addWorktree('b', 'Fix login redirect')
    await repo.write('src/shared.ts', 'changed\n', a.path)
    await ledger.claim({ worktreeId: 'a', globs: ['src/**'] })
    await ledger.note({ worktreeId: 'a', kind: 'question', text: 'Which store?' })
    await ledger.refresh()
    await ledger.close()

    ledger = open()
    const reopened = await ledger.inspect('p1')
    expect(reopened.worktrees.find((row) => row.id === 'a')).toMatchObject({
      claims: ['src/**'],
      touched: ['src/shared.ts']
    })
    expect(reopened.notes.map((note) => note.text)).toEqual(['Which store?'])
  })

  it('drops a removed worktree’s notes and claims', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    await ledger.claim({ worktreeId: a.id, globs: ['src/**'] })
    await ledger.note({ worktreeId: a.id, kind: 'decision', text: 'Use postgres' })
    worktrees = []
    await ledger.refresh()
    const after = await ledger.inspect('p1')
    expect(after.worktrees).toEqual([])
    expect(after.notes).toEqual([])
  })
})
