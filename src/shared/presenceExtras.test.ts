import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_PEER_MEMORY_BYTES } from './memory'
import { MAX_PEER_PATHS, PEER_TASK_CHARS, PeerPresenceExtrasOnRead, PeerWorktreeExtrasOnRead } from './presenceExtras'

// The shape a receiver has today, extended the way a receiver adopting presence v2 will.
const Worktree = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    branch: z.string(),
    state: z.string(),
    panes: z.array(z.unknown())
  })
  .extend(PeerWorktreeExtrasOnRead)
const Presence = z.object({ revision: z.number(), projects: z.array(z.unknown()) }).extend(PeerPresenceExtrasOnRead)

const old = { id: 'w1', name: 'rate limits', branch: 'rate-limits', state: 'ready', panes: [] }

describe('presence v2 on read', () => {
  it('reads an old snapshot unchanged', () => {
    expect(Worktree.parse(old)).toEqual(old)
    expect(Presence.parse({ revision: 1, projects: [] })).toEqual({ revision: 1, projects: [] })
  })

  it('round-trips a new one', () => {
    const next = {
      ...old,
      task: 'Add rate limits',
      parentId: 'w0',
      paths: ['src/limiter.ts'],
      ahead: 2,
      stage: 'done',
      report: { outcome: 'succeeded', summary: 'Added limiter.' },
      memory: {
        revision: 3,
        notes: [{ id: 'n1', kind: 'decision', text: 'Postgres locks', at: 1 }],
        touched: ['src/limiter.ts']
      }
    }
    expect(Worktree.parse(next)).toEqual(next)
    const handoff = { id: 'h1', to: 'ana', worktreeName: 'auth', branch: 'auth', note: 'finish it', at: 1 }
    expect(Presence.parse({ revision: 1, projects: [], handoffs: [handoff], took: ['h0'] })).toMatchObject({
      handoffs: [handoff],
      took: ['h0']
    })
  })

  it('drops a malformed field and keeps the worktree', () => {
    const parsed = Worktree.parse({ ...old, stage: 'vibing', ahead: -1, parentId: 7, report: { outcome: 'meh' } })
    expect(parsed).toEqual(old)
  })

  it('bounds what it keeps', () => {
    const parsed = Worktree.parse({
      ...old,
      task: 'x'.repeat(1000),
      paths: Array.from({ length: 10_000 }, (_, index) => `f${index}.ts`),
      memory: { revision: 1, notes: [], touched: ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000)] }
    })
    expect(parsed.task).toHaveLength(PEER_TASK_CHARS)
    expect(parsed.paths).toHaveLength(MAX_PEER_PATHS)
    expect(JSON.stringify({ touched: ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000)] }).length).toBeGreaterThan(
      MAX_PEER_MEMORY_BYTES
    )
    expect(parsed.memory).toBeUndefined()
  })
})
