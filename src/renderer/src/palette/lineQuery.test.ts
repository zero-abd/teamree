// What ⌘P reads off the end of a pasted location: the line, and the column when there is one.

import { describe, expect, it } from 'vitest'
import { lineQuery } from './lineQuery'

describe('a line suffix in the file query', () => {
  it.each([
    ['src/lib/mod7.ts', { path: 'src/lib/mod7.ts' }],
    ['src/lib/mod7.ts:3', { path: 'src/lib/mod7.ts', line: 3 }],
    ['src/lib/mod7.ts:3:14', { path: 'src/lib/mod7.ts', line: 3, column: 14 }],
    ['src/lib/mod7.ts(3,14)', { path: 'src/lib/mod7.ts', line: 3, column: 14 }],
    ['src/lib/mod7.ts(3)', { path: 'src/lib/mod7.ts', line: 3 }],
    ['  mod7.ts:3  ', { path: 'mod7.ts', line: 3 }],
    // Half typed: the colon waits for its number without losing the match.
    ['mod7.ts:', { path: 'mod7.ts' }],
    ['mod7.ts:3:', { path: 'mod7.ts', line: 3 }],
    [':42', { path: '', line: 42 }],
    [':', { path: '' }],
    ['mod7.ts:0', { path: 'mod7.ts' }]
  ])('reads %j', (typed, wanted) => {
    expect(lineQuery(typed)).toEqual(wanted)
  })
})
