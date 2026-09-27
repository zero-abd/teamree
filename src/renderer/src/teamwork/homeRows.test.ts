import { describe, expect, it } from 'vitest'
import type {
  MemberList,
  PeerLink,
  TeammatePresenceRead,
  TeammateStanding,
  TeammateWorktree,
  TeamworkRead
} from '@shared/entities'
import type { SharedNoteSummary } from '@shared/sharedNote'
import type { PeerHandoff } from '@shared/tasks'
import {
  activityWhen,
  presenceLabel,
  teamActivity,
  teamLine,
  teamMembers,
  waitingOnYou,
  type TeamMemory
} from './homeRows'

const NOW = Date.UTC(2026, 8, 27, 15, 0, 0)
const ANA = 'YW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW4='
const BO = 'Ym9ib2JvYm9ib2JvYm9ib2JvYm9ib2JvYm9ib2JvYm8='
const CY = 'Y3ljeWN5Y3ljeWN5Y3ljeWN5Y3ljeWN5Y3ljeWN5Y3k='

const roster = (): MemberList => ({
  projectId: 'p1',
  members: [
    { handle: 'ana', publicKey: ANA, addedAt: '2026-09-27', file: '.teamree/members/ana.pub', isSelf: true },
    { handle: 'bo', publicKey: BO, addedAt: '2026-09-26', file: '.teamree/members/bo.pub', isSelf: false },
    { handle: 'cy', publicKey: CY, addedAt: '2026-09-20', file: '.teamree/members/cy.pub', isSelf: false }
  ],
  problems: [],
  self: { handle: 'ana', publicKey: ANA },
  selfFile: '.teamree/members/ana.pub',
  enrolled: true,
  watched: true,
  readAt: NOW
})

const theirs = (overrides: Partial<TeammateWorktree> = {}): TeammateWorktree => ({
  id: 'peer:bo:wt_1',
  handle: 'bo',
  publicKey: BO,
  name: 'cart totals',
  branch: 'cart-totals',
  state: 'ready',
  heardAt: NOW - 1_000,
  live: true,
  panes: [
    { id: 'peer:bo:t_1', title: 'claude', shell: '/bin/zsh', agent: 'claude', running: true, busy: true, quietForMs: 0 }
  ],
  task: 'Fix cart totals rounding',
  stage: 'working',
  ...overrides
})

const standing = (handle: string, publicKey: string, connected: boolean, heardAt: number | null): TeammateStanding => ({
  handle,
  publicKey,
  connected,
  heardAt
})

const presence = (
  worktrees: TeammateWorktree[] = [theirs()],
  teammates: TeammateStanding[] = [standing('bo', BO, true, NOW - 1_000), standing('cy', CY, false, null)]
): TeammatePresenceRead => ({ state: 'read', projectId: 'p1', worktrees, teammates, readAt: NOW })

const link = (publicKey: string, handle: string, phase: PeerLink['phase'], detail?: string): PeerLink => ({
  publicKey,
  handle,
  phase,
  since: NOW - 5_000,
  attempts: 1,
  ...(detail === undefined ? {} : { detail })
})

const status = (links: PeerLink[]): TeamworkRead => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'ws://127.0.0.1:1/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true, url: '/srv/shop.git' },
  enrolled: true,
  links,
  readAt: NOW
})

const empty = (): TeamMemory => ({ lastOnline: new Map(), landedAt: new Map(), taken: new Map() })

describe('who is on the team', () => {
  it('puts you first, then who is online, then who is away, then who was never seen', () => {
    const members = teamMembers({
      list: roster(),
      presence: presence(),
      status: status([link(BO, 'bo', 'connected'), link(CY, 'cy', 'waiting')]),
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(members.map((member) => [member.handle, member.presence])).toEqual([
      ['ana', 'you'],
      ['bo', 'online'],
      ['cy', 'unseen']
    ])
  })

  it('says when an away teammate was last seen, by this machine’s clock', () => {
    const memory = empty()
    memory.lastOnline.set(BO, NOW - 5 * 60_000)
    const [, bo] = teamMembers({
      list: roster(),
      presence: presence([theirs({ live: false })], [standing('bo', BO, false, NOW - 60 * 60_000)]),
      status: status([link(BO, 'bo', 'waiting')]),
      own: [],
      memory,
      now: NOW
    })
    expect(bo?.presence).toBe('away')
    expect(presenceLabel(bo!, NOW)).toBe('away · last seen 5m ago')
  })

  it('falls back to the age of their last picture when this window never saw them online', () => {
    const [, bo] = teamMembers({
      list: roster(),
      presence: presence([], [standing('bo', BO, false, NOW - 2 * 60 * 60_000)]),
      status: undefined,
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(presenceLabel(bo!, NOW)).toBe('away · last seen 2h ago')
  })

  it('names what each teammate’s agents are doing, and the pane to jump to', () => {
    const [, bo] = teamMembers({
      list: roster(),
      presence: presence([
        theirs(),
        theirs({ id: 'peer:bo:wt_2', name: 'payment retry', task: 'Retry payments', stage: 'landed', panes: [] })
      ]),
      status: undefined,
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(bo?.worktrees.map((worktree) => [worktree.name, worktree.word])).toEqual([
      ['Fix cart totals rounding', 'working'],
      ['Retry payments', 'merged']
    ])
    expect(bo?.worktrees[0]?.pane?.terminalId).toBe('peer:bo:t_1')
    expect(bo?.worktrees[1]?.pane).toBeUndefined()
  })

  it('puts what is asking and working ahead of what has finished or merged', () => {
    const [, bo] = teamMembers({
      list: roster(),
      presence: presence([
        theirs({ id: 'peer:bo:wt_0', task: 'Landed one', stage: 'landed', panes: [] }),
        theirs({ id: 'peer:bo:wt_1', task: 'Working one' }),
        theirs({ id: 'peer:bo:wt_2', task: 'Asking one', stage: 'asking' })
      ]),
      status: undefined,
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(bo?.worktrees.map((worktree) => worktree.name)).toEqual(['Asking one', 'Working one', 'Landed one'])
  })

  it('opens the pane that is doing something rather than one that has ended', () => {
    const ended = {
      id: 'peer:bo:t_0',
      title: 'claude',
      shell: '/bin/zsh',
      running: false,
      exitCode: 0,
      busy: false,
      quietForMs: 0
    }
    const [, bo] = teamMembers({
      list: roster(),
      presence: presence([theirs({ panes: [ended, ...theirs().panes] })]),
      status: undefined,
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(bo?.worktrees[0]?.pane?.terminalId).toBe('peer:bo:t_1')
  })

  it('lists your own worktrees under you', () => {
    const [ana] = teamMembers({
      list: roster(),
      presence: presence(),
      status: undefined,
      own: [{ id: 'wt_a', name: 'search', tone: 'waiting' }],
      memory: empty(),
      now: NOW
    })
    expect(ana?.worktrees).toEqual([{ id: 'wt_a', name: 'search', word: 'asking', tone: 'waiting', own: true }])
  })

  it('still lists the roster before teamwork has heard from anybody', () => {
    const members = teamMembers({
      list: roster(),
      presence: undefined,
      status: undefined,
      own: [],
      memory: empty(),
      now: NOW
    })
    expect(members.map((member) => member.presence)).toEqual(['you', 'unseen', 'unseen'])
    expect(presenceLabel(members[1]!, NOW)).toBe('not seen yet')
  })
})

describe('what is waiting on you', () => {
  const handoff = (overrides: Partial<PeerHandoff> = {}): PeerHandoff => ({
    id: 'h1',
    to: 'ana',
    from: 'bo',
    worktreeName: 'payment retry',
    branch: 'payment-retry',
    note: 'needs a test',
    at: NOW - 60_000,
    ...overrides
  })

  it('lists work handed to you, newest first', () => {
    const waiting = waitingOnYou({
      handoffs: {
        incoming: [handoff(), handoff({ id: 'h2', worktreeName: 'refunds', at: NOW - 1_000 })],
        outgoing: []
      },
      presence: undefined,
      now: NOW
    })
    expect(waiting.map((item) => (item.kind === 'handoff' ? item.handoff.id : item.kind))).toEqual(['h2', 'h1'])
  })

  it('lists a teammate’s agent asking with answers you can give from here', () => {
    const asking = theirs({
      panes: [
        {
          id: 'peer:bo:t_1',
          title: 'claude',
          shell: '/bin/zsh',
          agent: 'claude',
          running: true,
          busy: false,
          quietForMs: 0,
          asking: true,
          menu: { prompt: 'fp', choices: [{ label: 'Yes', keys: ['\r'] }] }
        }
      ]
    })
    const waiting = waitingOnYou({ handoffs: undefined, presence: presence([asking]), now: NOW })
    expect(waiting).toHaveLength(1)
    const [item] = waiting
    expect(item?.kind).toBe('asking')
    if (item?.kind === 'asking') {
      expect(item.handle).toBe('bo')
      expect(item.worktree).toBe('Fix cart totals rounding')
      expect(item.pane.choices?.map((choice) => choice.label)).toEqual(['Yes'])
    }
  })

  it('leaves out an asking pane that cannot be answered from here', () => {
    const muted = theirs({
      panes: [
        {
          id: 'peer:bo:t_1',
          title: 'claude',
          shell: '/bin/zsh',
          running: true,
          busy: false,
          quietForMs: 0,
          asking: true,
          muted: true,
          menu: { prompt: 'fp', choices: [{ label: 'Yes', keys: ['\r'] }] }
        }
      ]
    })
    expect(waitingOnYou({ handoffs: undefined, presence: presence([muted]), now: NOW })).toEqual([])
  })
})

describe('the team’s recent activity', () => {
  const note = (overrides: Partial<SharedNoteSummary> = {}): SharedNoteSummary => ({
    shareId: 's1',
    projectId: 'p1',
    handle: 'bo',
    publicKey: BO,
    noteId: 'n1',
    title: 'Release checklist',
    sentAt: NOW - 120_000,
    receivedAt: NOW - 120_000,
    seen: false,
    bytes: 10,
    ...overrides
  })

  it('reads joins, handoffs, takes, notes and merges, newest first', () => {
    const memory = empty()
    memory.landedAt.set('peer:bo:wt_1', NOW - 30_000)
    const items = teamActivity({
      list: roster(),
      handoffs: {
        incoming: [
          { id: 'h1', to: 'ana', from: 'bo', worktreeName: 'refunds', branch: 'r', note: '', at: NOW - 90_000 }
        ],
        outgoing: [
          {
            id: 'h2',
            to: 'bo',
            from: 'ana',
            worktreeName: 'search',
            branch: 's',
            note: '',
            at: NOW - 600_000,
            takenAt: NOW - 300_000
          }
        ]
      },
      notes: [note()],
      presence: presence([theirs({ stage: 'landed' })]),
      memory,
      projectId: 'p1'
    })
    expect(items.map((item) => item.text)).toEqual([
      'bo merged Fix cart totals rounding',
      'bo handed you refunds',
      'bo shared Release checklist',
      'bo took search',
      'you handed search to bo',
      'you joined',
      'bo joined',
      'cy joined'
    ])
    expect(items[0]?.handle).toBe('bo')
    expect(items.find((item) => item.text === 'you joined')?.handle).toBe('ana')
  })

  it('keeps a handoff you took, which the runtime no longer lists as offered', () => {
    const memory = empty()
    memory.taken.set('h1', {
      projectId: 'p1',
      at: NOW - 5_000,
      handoff: { id: 'h1', to: 'ana', from: 'bo', worktreeName: 'refunds', branch: 'r', note: '', at: NOW - 90_000 }
    })
    const items = teamActivity({
      list: undefined,
      handoffs: undefined,
      notes: [],
      presence: undefined,
      memory,
      projectId: 'p1'
    })
    expect(items.map((item) => item.text)).toEqual(['you took refunds', 'bo handed you refunds'])
    expect(
      teamActivity({ list: undefined, handoffs: undefined, notes: [], presence: undefined, memory, projectId: 'p2' })
    ).toEqual([])
  })

  it('says nothing about a merge it did not see happen', () => {
    const items = teamActivity({
      list: undefined,
      handoffs: undefined,
      notes: [],
      presence: presence([theirs({ stage: 'landed' })]),
      memory: empty(),
      projectId: 'p1'
    })
    expect(items).toEqual([])
  })

  it('says when, to the minute for events and to the day for joins', () => {
    expect(activityWhen({ key: 'k', handle: 'bo', text: '', at: NOW - 3 * 60_000, day: false }, NOW)).toBe('3m ago')
    const today = new Date(NOW)
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    expect(activityWhen({ key: 'k', handle: 'bo', text: '', at: midnight, day: true }, NOW)).toBe('today')
    expect(activityWhen({ key: 'k', handle: 'bo', text: '', at: midnight - 86_400_000, day: true }, NOW)).toBe(
      'yesterday'
    )
  })
})

describe('the one line above the team when it cannot be reached', () => {
  it('says the relay is unreachable when no teammate is connected and the relay is why', () => {
    expect(teamLine(status([link(BO, 'bo', 'unreachable', 'connect ECONNREFUSED')]))).toBe('Relay unreachable')
  })

  it('says nothing while anybody is connected, or nobody is on the team yet', () => {
    expect(teamLine(status([link(BO, 'bo', 'connected'), link(CY, 'cy', 'unreachable')]))).toBeNull()
    expect(teamLine(status([]))).toBeNull()
    expect(teamLine(undefined)).toBeNull()
  })

  it('says a teammate is simply away without calling it a fault', () => {
    expect(teamLine(status([link(BO, 'bo', 'waiting')]))).toBeNull()
  })
})
