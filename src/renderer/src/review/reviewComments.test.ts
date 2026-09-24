import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import { agentTargets, commentMessage, lineRef, pasted, type ReviewComment } from './reviewComments'

const added = (newNumber: number, text: string) => ({ kind: 'added', text, oldNumber: null, newNumber }) as const
const context = (oldNumber: number, newNumber: number, text: string) =>
  ({ kind: 'context', text, oldNumber, newNumber }) as const
const removed = (oldNumber: number, text: string) => ({ kind: 'removed', text, oldNumber, newNumber: null }) as const

const SUB: ReviewComment = {
  path: 'src/math.ts',
  lines: [added(9, 'export function sub(a: number, b: number): number {'), added(10, '  return a - b'), added(11, '}')],
  note: 'Rename to subtract.'
}

describe('a review comment as the agent reads it', () => {
  it('names one line by its number and quotes it plainly when it is unchanged', () => {
    const one: ReviewComment = { path: 'src/math.ts', lines: [context(6, 6, '  return a * b')], note: 'Guard NaN.' }
    expect(lineRef(one)).toBe('src/math.ts:6')
    expect(commentMessage([one])).toBe('src/math.ts:6\n```\n  return a * b\n```\nGuard NaN.')
  })

  it('names a range by its first and last line, and quotes changed lines as a diff', () => {
    expect(lineRef(SUB)).toBe('src/math.ts:9-11')
    expect(commentMessage([SUB])).toBe(
      [
        'src/math.ts:9-11',
        '```diff',
        '+export function sub(a: number, b: number): number {',
        '+  return a - b',
        '+}',
        '```',
        'Rename to subtract.'
      ].join('\n')
    )
  })

  it('numbers a removal by the old file when nothing in it survives', () => {
    expect(lineRef({ path: 'a.ts', lines: [removed(4, 'x'), removed(5, 'y')], note: '' })).toBe('a.ts:4-5')
  })

  it('puts a batch in one message, one comment after another', () => {
    const other: ReviewComment = { path: 'docs/NOTES.md', lines: [added(3, 'sub() added.')], note: 'Say why.' }
    expect(commentMessage([SUB, other])).toBe(`${commentMessage([SUB])}\n\n${commentMessage([other])}`)
  })

  it('fences a quote that holds a fence with a longer one', () => {
    const fenced: ReviewComment = { path: 'README.md', lines: [context(1, 1, '```ts')], note: 'Close it.' }
    expect(commentMessage([fenced])).toBe('README.md:1\n````\n```ts\n````\nClose it.')
  })

  it('wraps what it types as a paste, so a newline does not submit it', () => {
    expect(pasted('a\nb')).toBe('\x1b[200~a\nb\x1b[201~')
  })
})

describe('where a comment can go', () => {
  const pane = (id: string, fields: Partial<Terminal>): Terminal =>
    ({
      id,
      worktreeId: 'w1',
      title: 'zsh',
      shell: '/bin/zsh',
      running: true,
      busy: false,
      lastOutputAt: 0,
      ...fields
    }) as Terminal

  it('offers the worktree’s running agent panes and never a shell', () => {
    const terminals = {
      shell: pane('shell', {}),
      claude: pane('claude', { agent: 'claude' }),
      typed: pane('typed', { foregroundAgent: 'codex' }),
      gone: pane('gone', { agent: 'claude', running: false }),
      elsewhere: pane('elsewhere', { agent: 'claude', worktreeId: 'w2' })
    }
    expect(agentTargets(terminals, 'w1').map((terminal) => terminal.id)).toEqual(['claude', 'typed'])
  })
})
