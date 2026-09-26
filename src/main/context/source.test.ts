import { describe, expect, it } from 'vitest'
import { emptyProjectContext } from '../../shared/memory'
import { askSources, type ContextSource } from './source'

const query = { projectId: 'p1', worktreeId: 'w1', budgetTokens: 500 }
const builtIn: ContextSource = {
  name: 'ledger',
  context: async () => ({ ...emptyProjectContext('w1'), text: 'built in' })
}

describe('context sources', () => {
  it('answers from the built-in ledger when there is nothing else', async () => {
    const answer = await askSources([], builtIn, query, 50)
    expect(answer.text).toBe('built in')
    expect(answer.sources?.map((row) => row.name)).toEqual(['ledger'])
  })

  it('falls back to the built-in past a provider that hangs or throws, and says so', async () => {
    const hangs: ContextSource = { name: 'slow', context: () => new Promise(() => {}) }
    const throws: ContextSource = {
      name: 'broken',
      context: async () => {
        throw new Error('crashed')
      }
    }
    const answer = await askSources([hangs, throws], builtIn, query, 20)
    expect(answer.text).toBe('built in')
    expect(answer.sources).toEqual([
      expect.objectContaining({ name: 'slow', error: 'timeout' }),
      expect.objectContaining({ name: 'broken', error: 'crashed' }),
      expect.objectContaining({ name: 'ledger' })
    ])
  })
})
