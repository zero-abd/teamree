import { describe, expect, it } from 'vitest'
import type { TeammatePresence, TeammatePresenceRead, TeammateWorktree } from '@shared/entities'
import { TONE_LABEL } from './agentRows'
import { teammateRows, teammateTitle, unheardTeammates, unheardTitle } from './teammateRows'

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
    live: true,
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
    // The same ordering the local rows use: a failure outranks work in progress.
    expect(row?.tone).toBe('failed')
    expect(TONE_LABEL[row!.tone!]).toBe('failed')
  })

  it('names an unnamed pane from its title and shell', () => {
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
    expect(row?.panes.map((entry) => entry.label)).toEqual(['Claude Code', 'zsh', 'pytest'])
  })

  it('names a pane what its owner called it, as their own sidebar does', () => {
    const [row] = teammateRows(
      [
        theirWorktree({
          panes: [
            pane({ id: 'p1', label: 'api server' }),
            pane({ id: 'p2', agent: 'claude', label: 'review' }),
            pane({ id: 'p3', title: 'zsh' }),
            pane({ id: 'p4', title: 'zsh' }),
            // A task's agent is labelled with its worktree's name.
            pane({ id: 'p5', agent: 'codex', label: 'index compaction' })
          ]
        })
      ],
      NOW
    )
    expect(row?.panes.map((entry) => entry.label)).toEqual(['api server', 'review', 'zsh', 'zsh 2', 'index compaction'])
    expect(row?.panes.map((entry) => entry.text)).toEqual(['api server', 'review', 'zsh', 'zsh 2', 'index compaction'])
  })

  it('adds the time since the snapshot arrived to the silence its owner measured', () => {
    // Two clocks never agree, so what crosses is a duration; the reader adds what elapsed here.
    const [row] = teammateRows([theirWorktree({ heardAt: NOW - 20_000, panes: [pane({ quietForMs: 60_000 })] })], NOW)
    expect(row?.panes[0]?.quietFor).toBe(80_000)
    expect(row?.heardAgoMs).toBe(20_000)
  })

  it('never treats a clock ahead of this one as time already elapsed', () => {
    const [row] = teammateRows([theirWorktree({ heardAt: NOW + 5_000, panes: [pane({ quietForMs: 1_000 })] })], NOW)
    expect(row?.heardAgoMs).toBe(0)
    expect(row?.panes[0]?.quietFor).toBe(1_000)
  })

  it('quotes nothing from a pane nobody has opened, because nothing of it has crossed', () => {
    // Output flows only for a watched pane; null is the row saying it has nothing to quote.
    const [row] = teammateRows([theirWorktree({ panes: [pane()] })], NOW)
    expect(row?.panes[0]?.evidence).toBeNull()
  })

  it('quotes the last line of a pane somebody has open, and only that pane', () => {
    const [row] = teammateRows([theirWorktree({ panes: [pane(), pane({ id: 'peer:abc123:t_2' })] })], NOW, {
      'peer:abc123:t_1': '28 passed in 4.11s'
    })
    expect(row?.panes[0]?.evidence).toBe('28 passed in 4.11s')
    expect(row?.panes[1]?.evidence).toBeNull()
  })

  it('carries the owner’s dimensions, which is what a watcher letterboxes to', () => {
    const [row] = teammateRows([theirWorktree({ panes: [pane({ cols: 120, rows: 40 })] })], NOW)
    expect(row?.panes[0]?.cols).toBe(120)
    expect(row?.panes[0]?.rows).toBe(40)
  })

  it('leaves the dimensions unknown rather than guessing when a teammate sends none', () => {
    // A peer not rebuilt sends no size; answering 80x24 would have a watcher
    // draw a frame the output does not fit.
    const [row] = teammateRows([theirWorktree({ panes: [pane()] })], NOW)
    expect(row?.panes[0]?.cols).toBeUndefined()
    expect(row?.panes[0]?.rows).toBeUndefined()
  })

  it('says whose it is before it says anything else', () => {
    const [row] = teammateRows([theirWorktree({ panes: [pane()] })], NOW)
    expect(teammateTitle(row!)).toContain('priya’s worktree on their machine')
  })
})

describe('a teammate whose machine is away', () => {
  it('keeps their worktrees on screen, and says how old what is on them is', () => {
    const [row] = teammateRows([theirWorktree({ live: false, heardAt: NOW - 600_000, panes: [pane()] })], NOW)

    expect(row?.name).toBe('index compaction')
    expect(row?.live).toBe(false)
    expect(row?.staleness?.age).toBe('10m')
    expect(teammateTitle(row!)).toContain('priya’s machine is not connected')
  })

  it('carries the unrounded fact as well as the wording, so acting on a pane can gate on it', () => {
    // The badge forgives a blink; `live` does not, and anything that could reach a pane reads `live`.
    const [blinking] = teammateRows([theirWorktree({ live: false, heardAt: NOW - 1_000 })], NOW)
    expect(blinking?.staleness).toBeNull()
    expect(blinking?.live).toBe(false)
  })

  it('says nothing about age while their machine is answering', () => {
    const [row] = teammateRows([theirWorktree({ live: true, heardAt: NOW - 600_000 })], NOW)
    expect(row?.staleness).toBeNull()
    expect(teammateTitle(row!)).not.toContain('not connected')
  })
})

describe('a teammate never heard from', () => {
  const presence = (teammates: TeammatePresenceRead['teammates']): TeammatePresence => ({
    state: 'read',
    projectId: 'p1',
    worktrees: [],
    teammates,
    readAt: NOW
  })

  it('is named as unheard rather than shown as a teammate with no work', () => {
    const unheard = unheardTeammates(
      presence([
        { handle: 'marcus', publicKey: 'm==', connected: false, heardAt: null },
        { handle: 'priya', publicKey: 'p==', connected: true, heardAt: NOW }
      ])
    )
    expect(unheard).toEqual(['marcus'])
    expect(unheardTitle(unheard)).toContain('no worktrees to show')
  })

  it('is not the same as a teammate whose rows are simply old', () => {
    expect(
      unheardTeammates(presence([{ handle: 'bob', publicKey: 'b==', connected: false, heardAt: NOW - 1 }]))
    ).toEqual([])
  })

  it('says nothing at all before anything has been asked', () => {
    expect(unheardTeammates(undefined)).toEqual([])
  })
})

describe('a teammate’s task and its tree', () => {
  it('titles the row with the task and says the stage, with the report once done', () => {
    const [row] = teammateRows(
      [
        theirWorktree({
          task: 'Compact the search index nightly',
          stage: 'done',
          report: { outcome: 'succeeded', summary: 'Compaction runs at 2am.' }
        })
      ],
      NOW
    )
    expect(row?.name).toBe('Compact the search index nightly')
    expect(row?.stage).toBe('done')
    expect(row?.report).toBe('Compaction runs at 2am.')
  })

  it('keeps the report quiet while the task is still going', () => {
    const [row] = teammateRows(
      [theirWorktree({ stage: 'working', report: { outcome: 'succeeded', summary: 'Earlier run.' } })],
      NOW
    )
    expect(row?.report).toBeUndefined()
  })

  it('nests children under their parent, and a missing or circular parent at the top', () => {
    const rows = teammateRows(
      // In the runtime's order, by name.
      [
        theirWorktree({ id: 'peer:a:parent', name: 'a parent' }),
        theirWorktree({ id: 'peer:a:child', name: 'b child', parentId: 'peer:a:parent' }),
        theirWorktree({ id: 'peer:a:grandchild', name: 'c grandchild', parentId: 'peer:a:child' }),
        theirWorktree({ id: 'peer:a:orphan', name: 'd orphan', parentId: 'peer:a:gone' }),
        theirWorktree({ id: 'peer:a:loop1', name: 'e loop', parentId: 'peer:a:loop2' }),
        theirWorktree({ id: 'peer:a:loop2', name: 'f loop', parentId: 'peer:a:loop1' })
      ],
      NOW
    )
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ['a parent', 0],
      ['b child', 1],
      ['c grandchild', 2],
      ['d orphan', 0],
      ['e loop', 0],
      ['f loop', 1]
    ])
  })

  it('names the files and commits in the hover', () => {
    const [row] = teammateRows([theirWorktree({ paths: ['a.ts', 'b.ts'], ahead: 3 })], NOW)
    expect(teammateTitle(row!)).toContain('2 files · 3 ahead')
  })
})
