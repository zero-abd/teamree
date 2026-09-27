import { describe, expect, it } from 'vitest'
import {
  EMPTY_VISITS,
  lastVisits,
  readStoredVisits,
  stepVisits,
  visit,
  VISITS_KEPT,
  writeStoredVisits,
  type VisitHistory
} from './visitHistory'

const walk = (...ids: string[]): VisitHistory =>
  ids.reduce((history, id, at) => visit(history, id, null, at * 1000), EMPTY_VISITS)

const LIVE = new Set(['a', 'b', 'c', 'd'])

describe('the visit history', () => {
  it('goes back and forward through the worktrees in the order they were opened', () => {
    let history = walk('a', 'b', 'c')
    const back = stepVisits(history, -1, LIVE, 5000)
    expect(back?.visit.worktreeId).toBe('b')
    history = back!.history
    const twice = stepVisits(history, -1, LIVE, 6000)
    expect(twice?.visit.worktreeId).toBe('a')
    expect(stepVisits(twice!.history, -1, LIVE, 7000)).toBeNull()
    expect(stepVisits(twice!.history, 1, LIVE, 7000)?.visit.worktreeId).toBe('b')
  })

  it('drops what was ahead when somewhere new is opened after going back', () => {
    const back = stepVisits(walk('a', 'b', 'c'), -1, LIVE, 5000)!.history
    const branched = visit(back, 'd', null, 6000)
    expect(stepVisits(branched, 1, LIVE, 7000)).toBeNull()
    expect(stepVisits(branched, -1, LIVE, 7000)?.visit.worktreeId).toBe('b')
  })

  it('skips worktrees that are gone', () => {
    const history = walk('a', 'b', 'c')
    expect(stepVisits(history, -1, new Set(['a', 'c']), 5000)?.visit.worktreeId).toBe('a')
    expect(stepVisits(history, -1, new Set(['c']), 5000)).toBeNull()
  })

  it('keeps the pane focused in each, and one entry per stay', () => {
    let history = visit(EMPTY_VISITS, 'a', 't1', 0)
    history = visit(history, 'a', 't2', 10)
    history = visit(history, 'b', null, 20)
    expect(history.visits.map((entry) => entry.worktreeId)).toEqual(['a', 'b'])
    expect(stepVisits(history, -1, LIVE, 30)?.visit.paneId).toBe('t2')
  })

  it(`keeps the last ${VISITS_KEPT}`, () => {
    const ids = Array.from({ length: VISITS_KEPT + 10 }, (_, index) => (index % 2 === 0 ? 'a' : 'b'))
    const history = walk(...ids)
    expect(history.visits).toHaveLength(VISITS_KEPT)
    expect(history.index).toBe(VISITS_KEPT - 1)
  })

  it('answers when each worktree was last left, the one on screen now', () => {
    const history = walk('a', 'b', 'c', 'b')
    expect(lastVisits(history)).toEqual({ a: 1000, b: 3000, c: 3000 })
  })

  it('survives a reload, and reads a broken record as none', () => {
    const kept = new Map<string, string>()
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value)
    }
    const history = walk('a', 'b')
    writeStoredVisits(storage, history)
    expect(readStoredVisits(storage)).toEqual(history)
    for (const [key] of kept) kept.set(key, '{"visits":[{"worktreeId":3}],"index":9}')
    expect(readStoredVisits(storage)).toEqual(EMPTY_VISITS)
    expect(readStoredVisits(undefined)).toEqual(EMPTY_VISITS)
  })
})
