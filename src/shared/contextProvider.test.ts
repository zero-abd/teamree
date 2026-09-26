import { describe, expect, it } from 'vitest'
import { MAX_PROVIDER_LINE_CHARS, parseProviderLine } from './contextProvider'

const note = {
  id: 'n1',
  worktreeId: 'w1',
  kind: 'decision',
  text: 'Use advisory locks',
  scope: 'team',
  at: 1,
  author: 'me'
}

describe('context provider replies', () => {
  it('reads a hello, a context and an error', () => {
    expect(parseProviderLine('{"type":"hello","protocol":1,"name":"jac-memory","version":"0.1.0"}')).toMatchObject({
      type: 'hello',
      protocol: 1
    })
    const context = {
      type: 'context',
      id: 3,
      context: {
        self: { goal: 'Rework auth', decisions: [note], questions: [] },
        siblings: [
          {
            worktreeId: 'w2',
            name: 'tests',
            goal: 'Tests',
            state: 'working',
            owner: 'me',
            overlap: ['a.ts'],
            decisions: []
          }
        ]
      }
    }
    expect(parseProviderLine(JSON.stringify(context))).toEqual(context)
    expect(parseProviderLine('{"type":"error","id":3,"message":"no graph"}')).toMatchObject({ type: 'error' })
  })

  it('refuses what is not a reply', () => {
    expect(parseProviderLine('not json')).toBeUndefined()
    expect(parseProviderLine('{"type":"facts","id":1}')).toBeUndefined()
    expect(parseProviderLine('{"type":"context","id":"1","context":{}}')).toBeUndefined()
    const longNote = { ...note, text: 'x'.repeat(501) }
    expect(
      parseProviderLine(
        JSON.stringify({
          type: 'context',
          id: 1,
          context: { self: { goal: '', decisions: [longNote], questions: [] } }
        })
      )
    ).toBeUndefined()
    expect(parseProviderLine(`{"type":"error","message":"${'x'.repeat(MAX_PROVIDER_LINE_CHARS)}"}`)).toBeUndefined()
  })
})
