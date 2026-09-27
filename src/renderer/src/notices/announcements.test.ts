import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal, Worktree } from '@shared/entities'
import { Announcer, announcements, heardStates, type AnnounceInput } from './announcements'

const worktree = (id: string, name: string, overrides: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name.replace(/\s/g, '-'),
  path: `/w/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  ...overrides
})

const pane = (id: string, worktreeId: string, overrides: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId,
  title: 'claude',
  cwd: '/w',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  agent: 'claude',
  ...overrides
})

const asking: Partial<Terminal> = { agentEvent: { event: 'Notification', at: 0, detail: 'permission_prompt' } }
const working: Partial<Terminal> = { agentEvent: { event: 'UserPromptSubmit', at: 0 } }

const input = (terminals: Terminal[], overrides: Partial<AnnounceInput> = {}): AnnounceInput => ({
  terminals,
  worktrees: [worktree('w1', 'billing'), worktree('w2', 'fix typo')],
  mergePreviews: {},
  statuses: {},
  landings: {},
  overlaps: {},
  ...overrides
})

const said = (before: Terminal[], after: Terminal[], overrides: Partial<AnnounceInput> = {}): string[] =>
  announcements(heardStates(input(before, overrides)), heardStates(input(after, overrides)))

describe('what changed that is worth saying', () => {
  it('says a pane turned asking, failed or finished, by its worktree', () => {
    expect(said([pane('t1', 'w1', working)], [pane('t1', 'w1', asking)])).toEqual(['billing is asking'])
    expect(said([pane('t1', 'w1', working)], [pane('t1', 'w1', { running: false, exitCode: 1 })])).toEqual([
      'billing failed'
    ])
    expect(said([pane('t2', 'w2', working)], [pane('t2', 'w2', { agentEvent: { event: 'Stop', at: 0 } })])).toEqual([
      'fix typo finished'
    ])
  })

  it('says an agent asking you through teamree is asking', () => {
    expect(said([pane('t1', 'w1', working)], [pane('t1', 'w1', { ...working, askingYou: 11 })])).toEqual([
      'billing is asking'
    ])
  })

  it('says nothing on the first read, for a pane first seen, or while a state holds', () => {
    expect(announcements(null, heardStates(input([pane('t1', 'w1', asking)])))).toEqual([])
    expect(said([], [pane('t1', 'w1', asking)])).toEqual([])
    expect(said([pane('t1', 'w1', asking)], [pane('t1', 'w1', asking)])).toEqual([])
    expect(said([pane('t1', 'w1', asking)], [pane('t1', 'w1', working)])).toEqual([])
  })

  it('leaves out plain shells: only an agent is acted on', () => {
    const shell = { agent: undefined, title: 'zsh' }
    expect(said([pane('t1', 'w1', shell)], [pane('t1', 'w1', { ...shell, running: false, exitCode: 1 })])).toEqual([])
  })

  it('names the pane when its worktree has more than one agent', () => {
    const before = [pane('t1', 'w1', working), pane('t2', 'w1', { ...working, agent: 'codex' })]
    const after = [pane('t1', 'w1', working), pane('t2', 'w1', { ...asking, agent: 'codex' })]
    expect(said(before, after)).toEqual(['Codex in billing is asking'])
  })

  it('says a worktree would now conflict, once', () => {
    const conflicts = {
      w1: {
        worktreeId: 'w1',
        baseRef: 'origin/main',
        state: 'conflicts' as const,
        ahead: 1,
        conflicts: ['a.ts'],
        readAt: 0
      }
    }
    const before = heardStates(input([]))
    const after = heardStates(input([], { mergePreviews: conflicts }))
    expect(announcements(before, after)).toEqual(['billing would conflict'])
    expect(announcements(after, heardStates(input([], { mergePreviews: conflicts })))).toEqual([])
  })

  it('never says a landed worktree would conflict', () => {
    const landed = { landings: { w1: { worktreeId: 'w1', merged: true, readAt: 0 } } }
    expect(said([pane('t1', 'w1', working)], [pane('t1', 'w1', asking)], landed)).toEqual(['billing is asking'])
    expect(
      announcements(
        heardStates(input([], landed)),
        heardStates(
          input([], {
            ...landed,
            statuses: { w1: { conflicted: 2 } }
          })
        )
      )
    ).toEqual([])
  })
})

describe('the announcer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('speaks at once, then holds what follows until the gap has passed, as one line', () => {
    const say = vi.fn()
    const announcer = new Announcer(say, 3000)
    announcer.push(['billing is asking'])
    expect(say).toHaveBeenLastCalledWith('billing is asking')
    announcer.push(['fix typo finished'])
    announcer.push(['rate limits failed'])
    expect(say).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(say).toHaveBeenCalledTimes(2)
    expect(say).toHaveBeenLastCalledWith('fix typo finished. rate limits failed')
  })

  it('caps a burst at three, and counts the rest', () => {
    const say = vi.fn()
    const announcer = new Announcer(say, 3000)
    announcer.push(['a is asking', 'b is asking', 'c is asking', 'd is asking', 'e is asking'])
    expect(say).toHaveBeenLastCalledWith('a is asking. b is asking. c is asking. and 2 more')
  })

  it('says a repeated line once per burst', () => {
    const say = vi.fn()
    const announcer = new Announcer(say, 3000)
    announcer.push(['billing is asking'])
    announcer.push(['fix typo finished'])
    announcer.push(['fix typo finished'])
    vi.advanceTimersByTime(3000)
    expect(say).toHaveBeenLastCalledWith('fix typo finished')
  })

  it('stops its timer when stopped', () => {
    const say = vi.fn()
    const announcer = new Announcer(say, 3000)
    announcer.push(['a is asking'])
    announcer.push(['b is asking'])
    announcer.stop()
    vi.advanceTimersByTime(10_000)
    expect(say).toHaveBeenCalledTimes(1)
  })
})
