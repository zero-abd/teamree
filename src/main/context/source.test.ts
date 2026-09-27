import { describe, expect, it } from 'vitest'
import type { RelatedTask } from '../../shared/graphMemory'
import { emptyProjectContext } from '../../shared/memory'
import { askSources, mergeProviderContext, type ContextProvider, type ContextSource } from './source'

const query = { projectId: 'p1', worktreeId: 'w1', budgetTokens: 500 }
const builtIn: ContextSource = {
  name: 'ledger',
  context: async () => ({ ...emptyProjectContext('w1'), text: 'built in' })
}

const earlier: RelatedTask = {
  key: 'pr:7',
  name: 'rate-limit-the-api',
  branch: 'rate-limit-the-api',
  pr: 7,
  goal: 'Rate limit the public API',
  at: 1,
  outcome: 'merged',
  score: 9,
  files: ['src/limiter.ts'],
  terms: ['limit'],
  decisions: ['Counters live in the database']
}

describe('context sources', () => {
  it('answers from the built-in ledger when there is nothing else', async () => {
    const answer = await askSources([], builtIn, query, 50)
    expect(answer.text).toBe('built in')
    expect(answer.sources?.map((row) => row.name)).toEqual(['ledger'])
  })

  it('keeps the built-in answer past a provider that hangs or throws, and says so', async () => {
    const hangs: ContextProvider = { name: 'slow', context: () => new Promise(() => {}) }
    const throws: ContextProvider = {
      name: 'broken',
      context: async () => {
        throw new Error('crashed')
      }
    }
    const answer = await askSources([hangs, throws], builtIn, query, 20)
    expect(answer.text).toBe('built in')
    expect(answer.related).toBeUndefined()
    expect(answer.sources).toEqual([
      expect.objectContaining({ name: 'slow', error: 'timeout' }),
      expect.objectContaining({ name: 'broken', error: 'crashed' }),
      expect.objectContaining({ name: 'ledger' })
    ])
  })

  it('adds a provider’s earlier work below the ledger’s lines', async () => {
    const jac: ContextProvider = { name: 'jac-memory', context: async () => ({ related: [earlier] }) }
    const answer = await askSources([jac], builtIn, query, 50)
    expect(answer.text).toBe(
      'built in\nearlier: #7 rate-limit-the-api (merged) [src/limiter.ts]: Counters live in the database'
    )
    expect(answer.related).toEqual([earlier])
  })

  it('keeps earlier work inside the budget and out when its section is not asked for', () => {
    const base = { ...emptyProjectContext('w1'), text: 'x'.repeat(790) }
    const tight = mergeProviderContext(base, { related: [earlier] }, { budgetTokens: 200 })
    expect(tight.text).toBe(base.text)
    expect(tight.truncated).toEqual([{ section: 'related', dropped: 1 }])
    const others = mergeProviderContext(base, { related: [earlier] }, { budgetTokens: 4000, sections: ['siblings'] })
    expect(others).toBe(base)
  })
})
