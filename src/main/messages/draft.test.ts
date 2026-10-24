import { describe, expect, it } from 'vitest'
import { hasDraft, NO_DRAFT, typedInto } from './draft'

const after = (...keys: string[]): ReturnType<typeof typedInto> =>
  keys.reduce((draft, key) => typedInto(draft, key, false), NO_DRAFT)

describe('draft', () => {
  it.each([
    ['typed text', ['héllo'], 'héllo'],
    ['a paste, Returns and all', ['\x1b[200~a\rb\x1b[201~'], 'a\rb'],
    ['a newline', ['a', '\x1b\r', 'b'], 'a\nb'],
    ['a word erased', ['git commit ', '\x17'], 'git '],
    ['a line killed', ['one', '\x1b\r', 'two', '\x15'], 'one\n'],
    ['mouse and focus reports', ['\x1b[<0;3;4M', '\x1b[M !!', '\x1b[I', '\x1b[O'], ''],
    ['a Return', ['abc', '\r'], '']
  ])('reads %s', (_name, keys, text) => {
    expect(after(...keys).text).toBe(text)
  })

  it('counts recalled history and completions as a draft until sent', () => {
    expect(hasDraft(after('\x1b[A'))).toBe(true)
    expect(hasDraft(after('src/ma', '\t', '\x7f'.repeat(6)))).toBe(true)
    expect(hasDraft(after('\t'))).toBe(false)
    expect(hasDraft(after('\x1b[A', '\r'))).toBe(false)
  })

  it('leaves the draft alone while keys answer a menu', () => {
    const draft = typedInto(typedInto(after('keep'), '\x1b[B', true), '\r', false)
    expect(draft).toMatchObject({ text: 'keep', answering: false })
    expect(typedInto(draft, 'x', false).text).toBe('keepx')
  })
})
