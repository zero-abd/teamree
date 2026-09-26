import { describe, expect, it } from 'vitest'
import { nestRefusal, type NestNode } from './nesting'

const node = (id: string, parentId?: string, extra: Partial<NestNode> = {}): NestNode => ({
  id,
  name: id,
  projectId: 'p1',
  state: 'ready',
  ...(parentId === undefined ? {} : { parentId }),
  ...extra
})

describe('nestRefusal', () => {
  it('allows a top-level worktree under another, and a child back to the top', () => {
    const rows = [node('a'), node('b'), node('c', 'a')]
    expect(nestRefusal(rows, 'b', 'a')).toBeNull()
    expect(nestRefusal(rows, 'c', 'b')).toBeNull()
    expect(nestRefusal(rows, 'c', null)).toBeNull()
  })

  it('names what the records refuse', () => {
    const rows = [node('a'), node('b', 'a'), node('c', 'b'), node('x', undefined, { projectId: 'p2' })]
    const code = (child: string, parent: string | null): string | undefined => nestRefusal(rows, child, parent)?.refusal
    expect(code('a', 'a')).toBe('same')
    expect(nestRefusal(rows, 'peer:abc:w1', 'a')).toEqual({ refusal: 'teammate', reason: "Teammate's worktree" })
    expect(code('a', 'peer:abc:w1')).toBe('teammate')
    expect(code('gone', 'a')).toBe('missing')
    expect(code('a', 'gone')).toBe('missing')
    expect(code('x', 'a')).toBe('project')
    expect(nestRefusal(rows, 'a', 'c')).toEqual({ refusal: 'cycle', reason: 'c is under a' })
    expect(code('a', 'b')).toBe('cycle')
    expect(nestRefusal(rows, 'b', 'a')).toEqual({ refusal: 'unchanged', reason: 'Already under a' })
    expect(nestRefusal(rows, 'a', null)).toEqual({ refusal: 'unchanged', reason: 'Already top level' })
  })

  it('refuses a worktree that is not ready, at either end', () => {
    const rows = [node('a'), node('b', undefined, { state: 'removing' })]
    expect(nestRefusal(rows, 'b', 'a')).toEqual({ refusal: 'state', reason: 'b is removing' })
    expect(nestRefusal(rows, 'a', 'b')?.refusal).toBe('state')
  })

  it("counts the moved worktree's own subtree against the depth limit, for agents only", () => {
    // a > b > c is two deep; d carries one child, so under c it would reach four.
    const rows = [node('a'), node('b', 'a'), node('c', 'b'), node('d'), node('e', 'd')]
    expect(nestRefusal(rows, 'd', 'c', { limited: true })).toEqual({ refusal: 'depth', reason: '3 deep under a' })
    expect(nestRefusal(rows, 'd', 'b', { limited: true })).toBeNull()
    expect(nestRefusal(rows, 'd', 'c')).toBeNull()
  })

  it('stops agents at six children under one parent', () => {
    const rows = [node('a'), ...[1, 2, 3, 4, 5, 6].map((index) => node(`k${index}`, 'a')), node('b')]
    expect(nestRefusal(rows, 'b', 'a', { limited: true })).toEqual({
      refusal: 'children',
      reason: '6 open children under a'
    })
    expect(nestRefusal(rows, 'b', 'a')).toBeNull()
  })
})
