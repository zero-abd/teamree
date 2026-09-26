import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageStore } from './messageStore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamree-messages-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const note = (projectId: string, text: string) =>
  ({ projectId, kind: 'note', from: { worktreeId: 'w1' }, to: { worktreeId: 'w2' }, text }) as const

describe('MessageStore', () => {
  it('numbers messages across projects, oldest first, and reads them back after a restart', () => {
    const store = new MessageStore(dir, () => 5)
    store.add(note('p1', 'one'))
    store.add(note('p2', 'two'))
    const ask = store.add({ ...note('p1', 'which?'), kind: 'ask', options: ['a', 'b'] })
    store.update(ask.id, { state: 'answered', answeredBy: { you: true } })

    const again = new MessageStore(dir)
    expect(again.list().map((message) => [message.id, message.projectId, message.text])).toEqual([
      [1, 'p1', 'one'],
      [2, 'p2', 'two'],
      [3, 'p1', 'which?']
    ])
    expect(again.get(3)).toMatchObject({ state: 'answered', answeredBy: { you: true }, at: 5 })
    expect(again.add(note('p2', 'next')).id).toBe(4)
  })

  it('filters by project, party, kind and openness, and keeps the newest under a limit', () => {
    const store = new MessageStore(dir)
    store.add(note('p1', 'n'))
    const ask = store.add({ ...note('p1', 'q'), kind: 'ask', from: { worktreeId: 'w3', terminalId: 't3' } })
    store.add({ ...note('p1', 'd'), kind: 'done', outcome: 'succeeded' })
    expect(store.list({ worktreeId: 'w3' }).map((m) => m.text)).toEqual(['q'])
    expect(store.list({ terminalId: 't3' }).map((m) => m.text)).toEqual(['q'])
    expect(store.list({ kinds: ['done', 'note'] }).map((m) => m.text)).toEqual(['n', 'd'])
    expect(store.list({ limit: 2 }).map((m) => m.text)).toEqual(['q', 'd'])

    store.update(1, { state: 'delivered' })
    store.update(ask.id, { state: 'read' })
    // A read ask is still open until somebody answers it.
    expect(store.list({ open: true }).map((m) => m.text)).toEqual(['q', 'd'])
  })

  it('keeps the last messages of a project under its cap, and compacts the file', () => {
    const store = new MessageStore(dir, Date.now, 3)
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) store.add(note('p1', text))
    expect(store.list().map((m) => m.text)).toEqual(['e', 'f', 'g'])
    const lines = readFileSync(join(dir, 'p1.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(6)
    expect(new MessageStore(dir, Date.now, 3).list().map((m) => m.text)).toEqual(['e', 'f', 'g'])
  })

  it('skips a mangled line rather than losing the file', () => {
    const store = new MessageStore(dir)
    store.add(note('p1', 'kept'))
    appendFileSync(join(dir, 'p1.jsonl'), '{not json\n')
    expect(new MessageStore(dir).list().map((m) => m.text)).toEqual(['kept'])
  })
})
