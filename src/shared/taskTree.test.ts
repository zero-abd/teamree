import { describe, expect, it } from 'vitest'
import { descendantsOf } from './taskTree'

describe('descendantsOf', () => {
  const rows = [
    { id: 'a' },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'd', parentId: 'a' },
    { id: 'e' }
  ]

  it('lists the whole subtree, each child after its parent', () => {
    expect(descendantsOf(rows, 'a').map((row) => row.id)).toEqual(['b', 'c', 'd'])
    expect(descendantsOf(rows, 'e')).toEqual([])
  })

  it('stops at a cycle', () => {
    const looped = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' }
    ]
    expect(descendantsOf(looped, 'x').map((row) => row.id)).toEqual(['y'])
  })
})
