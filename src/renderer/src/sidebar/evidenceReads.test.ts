import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import { EVIDENCE_INTERVAL_MS, forgetClosed, terminalsToRead, type EvidenceRead } from './evidenceReads'

function terminal(id: string, partial: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId: 'wt_1',
    title: 'sh',
    cwd: '/work',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...partial
  }
}

const read = (readAt: number, wasRunning = true): EvidenceRead => ({ readAt, wasRunning })

describe('terminalsToRead', () => {
  it('reads a pane it has never read', () => {
    expect(terminalsToRead({ visible: [terminal('t1')], reads: {}, now: 1000 })).toEqual(['t1'])
  })

  it('leaves a busy pane alone until the interval has passed', () => {
    const plan = { visible: [terminal('t1', { busy: true })], reads: { t1: read(1000) } }
    expect(terminalsToRead({ ...plan, now: 1000 + EVIDENCE_INTERVAL_MS - 1 })).toEqual([])
    expect(terminalsToRead({ ...plan, now: 1000 + EVIDENCE_INTERVAL_MS })).toEqual(['t1'])
  })

  it('never re-reads a quiet pane that has printed nothing since', () => {
    const quiet = terminal('t1', { busy: false, lastOutputAt: 900 })
    expect(terminalsToRead({ visible: [quiet], reads: { t1: read(1000) }, now: 1_000_000 })).toEqual([])
  })

  it('reads a quiet pane again once it has printed something new', () => {
    const spoke = terminal('t1', { busy: false, lastOutputAt: 2000 })
    expect(terminalsToRead({ visible: [spoke], reads: { t1: read(1000) }, now: 5000 })).toEqual(['t1'])
  })

  it('reads an exited pane once more, so the row settles on its last output', () => {
    const exited = terminal('t1', { running: false, exitCode: 0 })
    expect(terminalsToRead({ visible: [exited], reads: { t1: read(1000, true) }, now: 1010 })).toEqual(['t1'])
  })

  it('never reads an exited pane again after that, however long it sits there', () => {
    const exited = terminal('t1', { running: false, exitCode: 0 })
    expect(terminalsToRead({ visible: [exited], reads: { t1: read(1000, false) }, now: 1_000_000 })).toEqual([])
  })

  it('reads nothing for a pane that is not on screen', () => {
    expect(terminalsToRead({ visible: [], reads: {}, now: 1000 })).toEqual([])
  })

  it('puts a pane that has never been read ahead of one that is merely stale', () => {
    const plan = {
      visible: [terminal('stale', { busy: true }), terminal('fresh', { busy: true }), terminal('unread')],
      reads: { stale: read(0), fresh: read(100) },
      now: 100_000,
      limit: 2
    }
    expect(terminalsToRead(plan)).toEqual(['unread', 'stale'])
  })

  it('caps how many panes are read at once and leaves the rest for the next tick', () => {
    const visible = ['t1', 't2', 't3', 't4'].map((id) => terminal(id))
    const first = terminalsToRead({ visible, reads: {}, now: 1000, limit: 2 })
    expect(first).toHaveLength(2)

    const reads = Object.fromEntries(first.map((id) => [id, read(1000)]))
    expect(terminalsToRead({ visible, reads, now: 1001, limit: 2 })).toEqual(
      visible.map((entry) => entry.id).filter((id) => !first.includes(id))
    )
  })
})

describe('forgetClosed', () => {
  it('drops what it knew about a terminal the runtime no longer lists', () => {
    expect(forgetClosed({ t1: 'a', t2: 'b' }, { t1: terminal('t1') })).toEqual({ t1: 'a' })
  })

  it('returns the same object when nothing has closed, so React sees no change', () => {
    const known = { t1: 'a' }
    expect(forgetClosed(known, { t1: terminal('t1') })).toBe(known)
  })
})
