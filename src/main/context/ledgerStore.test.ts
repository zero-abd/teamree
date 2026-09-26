import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LedgerStore, MAX_LANDINGS, emptyLedgerWorktree, type LandingRecord } from './ledgerStore'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'teamree-ledger-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const landing = (index: number): LandingRecord => ({
  worktreeId: `w${index}`,
  name: `w${index}`,
  into: 'main',
  landedAt: index,
  conflicts: [],
  shared: [],
  warnings: []
})

describe('the ledger file', () => {
  it('starts empty, and reads back what it wrote', async () => {
    const file = join(directory, 'memory', 'p1.json')
    const store = await LedgerStore.open(file, 'p1')
    expect(store.document.worktrees).toEqual([])

    store.document.worktrees.push({ ...emptyLedgerWorktree('w1'), goal: 'Add rate limits', touched: ['src/a.ts'] })
    store.document.notes.push({
      id: 'n1',
      worktreeId: 'w1',
      kind: 'decision',
      text: 'Use postgres',
      scope: 'private',
      paths: ['src/a.ts'],
      at: 1,
      author: 'me'
    })
    store.save()
    await store.flush()

    const again = await LedgerStore.open(file, 'p1')
    expect(again.document.worktrees[0]).toMatchObject({ id: 'w1', goal: 'Add rate limits', touched: ['src/a.ts'] })
    expect(again.document.notes.map((note) => note.id)).toEqual(['n1'])
  })

  it('salvages the records that parse and drops the rest', async () => {
    const file = join(directory, 'p1.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        revision: 7,
        worktrees: [{ ...emptyLedgerWorktree('w1'), goal: 'ok' }, { goal: 'no id' }, 'junk'],
        notes: [
          {
            id: 'n1',
            worktreeId: 'w1',
            kind: 'decision',
            text: 'x'.repeat(501),
            scope: 'private',
            at: 1,
            author: 'me'
          },
          { id: 'n2', worktreeId: 'w1', kind: 'decision', text: 'kept', scope: 'private', at: 1, author: 'me' }
        ],
        landings: 'not a list'
      })
    )
    const store = await LedgerStore.open(file, 'p1')
    expect(store.document.revision).toBe(7)
    expect(store.document.worktrees.map((worktree) => worktree.id)).toEqual(['w1'])
    expect(store.document.notes.map((note) => note.id)).toEqual(['n2'])
    expect(store.document.landings).toEqual([])
  })

  it('moves an unreadable file aside before writing over it', async () => {
    const file = join(directory, 'p1.json')
    await writeFile(file, '{ not json')
    const problems: string[] = []
    const store = await LedgerStore.open(file, 'p1', { onProblem: (problem) => problems.push(problem.kind) })
    expect(problems).toEqual(['unreadable'])
    store.document.worktrees.push(emptyLedgerWorktree('w1'))
    store.save()
    await store.flush()

    const names = await readdir(directory)
    expect(names.some((name) => name.startsWith('p1.json.unreadable-'))).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8')).worktrees).toHaveLength(1)
  })

  it('keeps only the newest landings', async () => {
    const store = await LedgerStore.open(join(directory, 'p1.json'), 'p1')
    for (let index = 0; index < MAX_LANDINGS + 5; index += 1) store.addLanding(landing(index))
    expect(store.document.landings).toHaveLength(MAX_LANDINGS)
    expect(store.document.landings[0]?.worktreeId).toBe('w5')
  })
})
