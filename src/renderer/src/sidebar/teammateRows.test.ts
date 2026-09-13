import { describe, expect, it } from 'vitest'
import type { TeammateWorktree } from '@shared/entities'
import { ACTIVITY_LABEL } from './agentRows'
import { teammateRows, teammateTitle } from './teammateRows'

const NOW = 1_700_000_000_000

function theirWorktree(overrides: Partial<TeammateWorktree> = {}): TeammateWorktree {
  return {
    id: 'peer:abc123:wt_1',
    handle: 'priya',
    publicKey: 'abc123==',
    name: 'index compaction',
    branch: 'perf/compaction',
    state: 'ready',
    heardAt: NOW,
    panes: [],
    ...overrides
  }
}

const pane = (overrides = {}) => ({
  id: 'peer:abc123:t_1',
  title: 'bash',
  shell: '/bin/zsh',
  running: true,
  busy: false,
  quietForMs: 0,
  ...overrides
})

describe('a teammate’s rows', () => {
  it('reads the same four states this app already has, by the same rule', () => {
    const [row] = teammateRows(
      [
        theirWorktree({
          panes: [
            pane({ id: 'p1', busy: true }),
            pane({ id: 'p2', busy: false }),
            pane({ id: 'p3', running: false, exitCode: 0 }),
            pane({ id: 'p4', running: false, exitCode: 1 })
          ]
        })
      ],
      NOW
    )
    expect(row?.panes.map((entry) => entry.activity)).toEqual(['working', 'quiet', 'done', 'failed'])
    // The worktree as a whole is read by the same ordering the local rows use:
    // a failure outranks work in progress, because it is finished and wrong.
    expect(row?.activity).toBe('failed')
    expect(ACTIVITY_LABEL[row!.activity!]).toBe('exited with an error')
  })

  it('names a pane from its title and shell, not from a label the owner chose', () => {
    const [row] = teammateRows(
      [
        theirWorktree({
          panes: [
            pane({ id: 'p1', agent: 'claude' }),
            // bash's default `user@host: path`, which the local rule already
            // refuses in favour of the shell's own name.
            pane({ id: 'p2', title: 'priya@laptop: ~/work' }),
            pane({ id: 'p3', title: 'pytest' })
          ]
        })
      ],
      NOW
    )
    expect(row?.panes.map((entry) => entry.label)).toEqual(['claude', 'zsh', 'pytest'])
  })

  it('adds the time since the snapshot arrived to the silence its owner measured', () => {
    // Two clocks never agree, so what crosses is a duration. The reader adds
    // what has elapsed here, which is the only part of it this machine knows.
    const [row] = teammateRows([theirWorktree({ heardAt: NOW - 20_000, panes: [pane({ quietForMs: 60_000 })] })], NOW)
    expect(row?.panes[0]?.quietFor).toBe(80_000)
    expect(row?.heardAgoMs).toBe(20_000)
  })

  it('never treats a clock ahead of this one as time already elapsed', () => {
    const [row] = teammateRows([theirWorktree({ heardAt: NOW + 5_000, panes: [pane({ quietForMs: 1_000 })] })], NOW)
    expect(row?.heardAgoMs).toBe(0)
    expect(row?.panes[0]?.quietFor).toBe(1_000)
  })

  it('quotes nothing a pane printed, because nothing a pane printed crosses yet', () => {
    // Milestone B sends metadata and no output. An empty evidence line would
    // read as an answer; null is the row saying it has nothing to quote.
    const [row] = teammateRows([theirWorktree({ panes: [pane()] })], NOW)
    expect(row?.panes[0]?.evidence).toBeNull()
  })

  it('says whose it is before it says anything else', () => {
    const [row] = teammateRows([theirWorktree({ panes: [pane()] })], NOW)
    expect(teammateTitle(row!)).toContain('priya’s worktree on their machine')
  })
})
