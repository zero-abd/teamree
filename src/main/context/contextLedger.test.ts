// The ledger against real git: sibling worktrees in a throwaway repository,
// merged and landed the way a person would, read through the service.

import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { ContextLedger } from './contextLedger'

let repo: TempRepo
let dataDir: string
let project: Project
let worktrees: Worktree[]
let ledger: ContextLedger
let warnAgents: boolean

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
    warnAgents: () => warnAgents,
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
  warnAgents = true
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

  it('still says conflict after a restart, before anything else asks for a pass', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await edit(b, 'line two from b')
    await repo.commit('b edits', b.path)
    await ledger.refresh()
    await ledger.close()

    ledger = open()
    const { overlaps } = await ledger.overlaps('p1')
    expect(overlaps.map((row) => row.conflicts)).toEqual([['src/shared.ts'], ['src/shared.ts']])
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
    await repo.write('src/extra.ts', 'x\n', b.path)

    await ledger.refresh()
    const [overlap] = (await ledger.overlaps('p1')).overlaps
    expect(overlap).toMatchObject({ paths: ['src/extra.ts', 'src/shared.ts'], conflicts: [] })
    expect((await ledger.context({ worktreeId: 'b' })).text).toContain('  overlap: src/extra.ts, src/shared.ts')
  })

  it('adds a teammate whose changed paths meet a live worktree’s, hot files marked', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    await edit(a, 'line two from a')
    await repo.write('package.json', '{}\n', a.path)
    await ledger.refresh()

    const { overlaps } = await ledger.overlaps('p1', [
      { handle: 'ana', worktreeId: 'peer:ana:w9', paths: ['package.json', 'src/shared.ts', 'src/other.ts'] },
      { handle: 'bo', worktreeId: 'peer:bo:w1', paths: ['docs/readme.md'] }
    ])
    expect(overlaps).toEqual([
      {
        worktreeId: 'a',
        with: { handle: 'ana', worktreeId: 'peer:ana:w9' },
        paths: ['src/shared.ts', 'package.json'],
        conflicts: [],
        hot: ['package.json']
      }
    ])
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

  it('lists every live claim and note for the window, overlap or not', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    await addWorktree('b', 'Fix login redirect')
    await repo.write('src/limits.ts', 'x\n', a.path)
    await ledger.claim({ worktreeId: 'a', globs: ['src/api/**'] })
    const note = await ledger.note({ worktreeId: 'b', kind: 'question', text: 'Keep v1 tokens?' })
    await ledger.refresh()

    const listed = await ledger.list('p1')
    expect(listed.worktrees).toEqual([
      { worktreeId: 'a', claims: ['src/api/**'], touched: ['src/limits.ts'] },
      { worktreeId: 'b', claims: [], touched: [] }
    ])
    expect(listed.notes).toEqual([note])
    expect(listed.revision).toBeGreaterThan(0)
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
        // Shown by `project.context`; the file did not conflict when a landed.
        warnings: [expect.objectContaining({ path: 'src/shared.ts', with: 'b', via: 'context', heeded: true })]
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
    await ledger.check({ worktreeId: 'b', path: path.join(b.path, 'src/shared.ts'), hook: true })

    await repo.git(['merge', '--ff-only', 'a'])
    await repo.runner.tryRun({ args: ['merge', '--no-ff', '-m', 'land b', 'b'], cwd: repo.repoPath })
    await edit({ path: repo.repoPath } as Worktree, 'line two from both')
    await repo.commit('land b')
    await ledger.refresh()

    const landed = (await ledger.inspect('p1')).landings
    expect(landed.find((row) => row.worktreeId === 'a')?.conflicts).toEqual([])
    expect(landed.find((row) => row.worktreeId === 'b')?.conflicts).toEqual(['src/shared.ts'])
    expect(landed.find((row) => row.worktreeId === 'b')?.warnings).toEqual([
      expect.objectContaining({ path: 'src/shared.ts', with: 'a', via: 'edit', heeded: false })
    ])
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

describe('uncommitted work', () => {
  it('predicts a conflict between two siblings that have not committed', async () => {
    const a = await addWorktree('a', 'Cart totals')
    const b = await addWorktree('b', 'Payment')
    await edit(a, 'line two from a')
    await edit(b, 'line two from b')

    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps).toEqual([
      {
        worktreeId: 'a',
        with: { worktreeId: 'b' },
        paths: ['src/shared.ts'],
        conflicts: ['src/shared.ts'],
        uncommitted: ['src/shared.ts']
      },
      {
        worktreeId: 'b',
        with: { worktreeId: 'a' },
        paths: ['src/shared.ts'],
        conflicts: ['src/shared.ts'],
        uncommitted: ['src/shared.ts']
      }
    ])
    expect((await ledger.check({ worktreeId: 'a', path: path.join(a.path, 'src/shared.ts') })).siblings).toEqual([
      { worktreeId: 'b', name: 'b', goal: 'Payment', kind: 'conflict' }
    ])
  })

  it('keeps uncommitted edits to different lines of one file an overlap', async () => {
    const a = await addWorktree('a', 'Cart totals')
    const b = await addWorktree('b', 'Payment')
    await repo.write('src/shared.ts', 'line one from a\nline two\nline three\n', a.path)
    await repo.write('src/shared.ts', 'line one\nline two\nline three from b\n', b.path)

    await ledger.refresh()
    const { overlaps } = await ledger.overlaps('p1')
    expect(overlaps.map((row) => [row.worktreeId, row.paths, row.conflicts])).toEqual([
      ['a', ['src/shared.ts'], []],
      ['b', ['src/shared.ts'], []]
    ])
    expect(overlaps.every((row) => row.uncommitted === undefined)).toBe(true)
  })

  it('still warns once one sibling lands, against the base that now holds it, until it is updated', async () => {
    const a = await addWorktree('a', 'Cart totals')
    const b = await addWorktree('b', 'Payment')
    await edit(a, 'line two from a')
    await edit(b, 'line two from b')
    await ledger.refresh()

    // Committed and landed between two passes, as Commit & Merge does.
    await repo.commit('a edits', a.path)
    await repo.git(['merge', '--no-ff', '-m', 'land a', 'a'])
    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps).toEqual([
      {
        worktreeId: 'b',
        with: { base: 'main' },
        paths: ['src/shared.ts'],
        conflicts: ['src/shared.ts'],
        uncommitted: ['src/shared.ts']
      }
    ])

    await repo.commit('b edits', b.path)
    await repo.runner.tryRun({ args: ['merge', 'main'], cwd: b.path })
    await edit(b, 'line two from both')
    await repo.commit('b takes main', b.path)
    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps).toEqual([])
  })

  it('names the parent when a child lands in it', async () => {
    const parent = await addWorktree('p', 'Checkout')
    const a = await addWorktree('a', 'Cart totals', 'p')
    const b = await addWorktree('b', 'Payment', 'p')
    await edit(a, 'line two from a')
    await edit(b, 'line two from b')
    await ledger.refresh()

    await repo.commit('a edits', a.path)
    await repo.git(['merge', '--no-ff', '-m', 'land a', 'a'], parent.path)
    await ledger.refresh()
    expect((await ledger.overlaps('p1')).overlaps).toEqual([
      expect.objectContaining({ worktreeId: 'b', with: { base: 'p', worktreeId: 'p' }, conflicts: ['src/shared.ts'] })
    ])
  })

  it('snapshots nothing and merges nothing again while a pair sits idle, and keys merges by tree', async () => {
    const a = await addWorktree('a', 'Cart totals')
    const b = await addWorktree('b', 'Payment')
    // Dated well before the pass, so the ledger may trust a file's date to say it is unchanged.
    const settled = async (worktree: Worktree, line: string): Promise<void> => {
      await edit(worktree, line)
      const past = Date.now() / 1000 - 60 + Math.random()
      await utimes(path.join(worktree.path, 'src/shared.ts'), past, past)
    }
    await settled(a, 'line two from a')
    await settled(b, 'line two from b')
    await ledger.refresh()
    const first = ledger.stats()
    expect(first.snapshots).toBe(2)
    expect(first.mergeTrees).toBe(1)

    await ledger.refresh()
    expect(ledger.stats()).toMatchObject({ snapshots: 2, mergeTrees: 1 })

    // Rewritten with the same bytes: a new snapshot, the same tree, no new merge.
    await settled(b, 'line two from b')
    await ledger.refresh()
    expect(ledger.stats()).toMatchObject({ snapshots: 3, mergeTrees: 1 })

    await settled(b, 'line two from b, again')
    await ledger.refresh()
    expect(ledger.stats()).toMatchObject({ snapshots: 4, mergeTrees: 2 })
  })

  it('runs no more merges a pass than the budget allows', async () => {
    ledger = open({ maxMergeTreesPerPass: 1 })
    for (const id of ['a', 'b', 'c']) await edit(await addWorktree(id, `task ${id}`), `line two from ${id}`)
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(1)
    await ledger.refresh()
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(3)
    await ledger.refresh()
    expect(ledger.stats().mergeTrees).toBe(3)
    expect((await ledger.conflicts('a')).map((row) => row.conflicts)).toEqual([['src/shared.ts'], ['src/shared.ts']])
  })

  it('leaves the real index alone', async () => {
    const a = await addWorktree('a', 'Cart totals')
    const b = await addWorktree('b', 'Payment')
    await edit(a, 'line two from a')
    await repo.write('src/new.ts', 'new\n', a.path)
    await edit(b, 'line two from b')
    await ledger.refresh()
    expect(await repo.git(['status', '--porcelain'], a.path)).toBe('M src/shared.ts\n?? src/new.ts')
  })
})

describe('before an agent edits a file', () => {
  const at = (worktree: Worktree, file = 'src/shared.ts'): string => path.join(worktree.path, file)

  it('names the sibling a merge would conflict with, in at most three lines, and says it once', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await edit(b, 'line two from b')
    await repo.commit('b edits', b.path)
    await ledger.refresh()
    const runs = ledger.stats().gitRuns

    const check = await ledger.check({ worktreeId: 'a', path: at(a), hook: true })
    expect(check).toEqual({
      worktreeId: 'a',
      path: 'src/shared.ts',
      siblings: [{ worktreeId: 'b', name: 'b', goal: 'Fix login redirect', kind: 'conflict' }],
      text: [
        'b (sibling: "Fix login redirect") also changes src/shared.ts — would conflict.',
        'Coordinate first: teamree msg ask --to b "<question>", or pick another file.'
      ].join('\n')
    })
    // Read from the last pass: an edit never waits on git.
    expect(ledger.stats().gitRuns).toBe(runs)
    expect((await ledger.check({ worktreeId: 'a', path: at(a), hook: true })).text).toBe('')
    const row = (await ledger.inspect('p1')).worktrees.find((worktree) => worktree.id === 'a')
    expect(row?.warnings).toEqual([
      expect.objectContaining({ path: 'src/shared.ts', with: 'b', via: 'edit', kind: 'conflict', heeded: null })
    ])
  })

  it('says nothing when no sibling changes or claims the file', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('src/b.ts', 'b\n', b.path)
    await ledger.refresh()
    const check = await ledger.check({ worktreeId: 'a', path: at(a, 'src/a.ts'), hook: true })
    expect(check).toEqual({ worktreeId: 'a', path: 'src/a.ts', siblings: [], text: '' })
    expect((await ledger.inspect('p1')).worktrees.find((row) => row.id === 'a')?.warnings).toEqual([])
  })

  it('warns about a sibling’s claim and a sibling’s uncommitted change', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', '')
    await ledger.claim({ worktreeId: 'b', globs: ['src/limiter/**'] })
    await repo.write('src/other.ts', 'b\n', b.path)
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a, 'src/limiter/core.ts') })).text).toBe(
      [
        'b (sibling) claims src/limiter/core.ts.',
        'Coordinate first: teamree msg ask --to b "<question>", or pick another file.'
      ].join('\n')
    )
    expect((await ledger.check({ worktreeId: 'a', path: at(a, 'src/other.ts') })).text.split('\n')[0]).toBe(
      'b (sibling) also changes src/other.ts.'
    )
  })

  it('counts the file an agent is about to edit as touched, so a sibling hears of it at once', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a, 'src/new.ts'), hook: true })).text).toBe('')
    expect((await ledger.check({ worktreeId: 'b', path: at(b, 'src/new.ts'), hook: true })).siblings).toEqual([
      { worktreeId: 'a', name: 'a', goal: 'Add rate limits', kind: 'changed' }
    ])
  })

  it('leaves a person’s check out of the log and the touched paths', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('src/shared.ts', 'b\n', b.path)
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a) })).siblings).toHaveLength(1)
    expect((await ledger.check({ worktreeId: 'a', path: at(a) })).text).not.toBe('')
    const row = (await ledger.inspect('p1')).worktrees.find((worktree) => worktree.id === 'a')
    expect(row).toMatchObject({ warnings: [], touched: [] })
  })

  it('ignores a lockfile only a sibling changes, and a path outside the worktree', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('package-lock.json', '{}\n', b.path)
    await repo.write('src/shared.ts', 'b\n', b.path)
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a, 'package-lock.json'), hook: true })).text).toBe('')
    expect((await ledger.check({ worktreeId: 'a', path: at(b), hook: true })).text).toBe('')
    expect((await ledger.check({ worktreeId: 'a', path: '/etc/hosts', hook: true })).siblings).toEqual([])
  })

  it('tells an agent nothing with Warn Agents About Overlaps off, and still answers a person', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await repo.write('src/shared.ts', 'b\n', b.path)
    await ledger.refresh()
    warnAgents = false
    expect(await ledger.check({ worktreeId: 'a', path: at(a), hook: true })).toEqual({
      worktreeId: 'a',
      path: 'src/shared.ts',
      siblings: [],
      text: ''
    })
    expect((await ledger.check({ worktreeId: 'a', path: at(a) })).siblings).toHaveLength(1)
    expect((await ledger.inspect('p1')).worktrees.find((row) => row.id === 'a')?.warnings).toEqual([])
  })

  it('re-reads only the worktrees a pass is scoped to, keeping the others as they were', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await ledger.refresh()
    await edit(a, 'line two from a')
    await edit(b, 'line two from b')

    const before = ledger.stats().gitRuns
    await ledger.refresh(undefined, ['a'])
    const rows = async (): Promise<Record<string, string[]>> =>
      Object.fromEntries((await ledger.inspect('p1')).worktrees.map((row) => [row.id, row.touched]))
    expect(await rows()).toEqual({ a: ['src/shared.ts'], b: [] })
    expect(ledger.stats().gitRuns - before).toBeLessThanOrEqual(4)

    await ledger.refresh()
    expect(await rows()).toEqual({ a: ['src/shared.ts'], b: ['src/shared.ts'] })
  })

  it('gathers the worktrees scheduled before a pass into that one pass', async () => {
    await ledger.close()
    ledger = new ContextLedger({
      dataDir,
      runner: repo.runner,
      snapshot: () => ({ projects: [project], worktrees }),
      refreshDelayMs: 5,
      minPassIntervalMs: 0
    })
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    const c = await addWorktree('c', 'Tidy the docs')
    await ledger.refresh()
    for (const worktree of [a, b, c]) await edit(worktree, `line two from ${worktree.id}`)

    ledger.schedule(['a'])
    ledger.schedule(['b'])
    await vi.waitFor(async () => expect(ledger.stats().passes).toBe(2))
    const touched = (await ledger.inspect('p1')).worktrees.map((row) => [row.id, row.touched.length])
    expect(touched).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 0]
    ])
  })

  it('says it again when a plain overlap becomes a conflict', async () => {
    const a = await addWorktree('a', 'Add rate limits')
    const b = await addWorktree('b', 'Fix login redirect')
    await edit(b, 'line two from b')
    await repo.commit('b edits', b.path)
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a), hook: true })).siblings[0]?.kind).toBe('changed')
    await edit(a, 'line two from a')
    await repo.commit('a edits', a.path)
    await ledger.refresh()
    expect((await ledger.check({ worktreeId: 'a', path: at(a), hook: true })).text).toContain('would conflict')
  })
})
