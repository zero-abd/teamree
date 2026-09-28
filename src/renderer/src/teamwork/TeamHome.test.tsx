/** @vitest-environment jsdom */

// The team's home: members with presence and what their agents do, what waits on you, notes and activity,
// each with a one-line empty state, and every row a way to the thing it names.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MemberList,
  TeammatePresenceRead,
  TeammateWorktree,
  Terminal,
  TeamworkRead,
  Worktree
} from '@shared/entities'
import type { PeerHandoff } from '@shared/tasks'

const call = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useHandoffs } = await import('./handoffsStore')
const { useSharedNotes } = await import('./sharedNotesStore')
const { useReviewRequests } = await import('./reviewRequestsStore')
const { useTeammateReview } = await import('../review/teammateReviewStore')
const { TeamHome, TeamInviteActions } = await import('./TeamHome')
const { teamMemory } = await import('./teamMemory')

const INITIAL = useWorkspaceStore.getState()
const NOW = Date.now()
const ANA = 'YW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW5hYW4='
const BO = 'Ym9ib2JvYm9ib2JvYm9ib2JvYm9ib2JvYm9ib2JvYm8='

const roster = (withBo = true): MemberList => ({
  projectId: 'p1',
  members: [
    { handle: 'ana', publicKey: ANA, addedAt: '2026-09-27', file: '.teamree/members/ana.pub', isSelf: true },
    ...(withBo
      ? [{ handle: 'bo', publicKey: BO, addedAt: '2026-09-27', file: '.teamree/members/bo.pub', isSelf: false }]
      : [])
  ],
  problems: [],
  self: { handle: 'ana', publicKey: ANA },
  selfFile: '.teamree/members/ana.pub',
  enrolled: true,
  watched: true,
  readAt: NOW
})

const status = (phase: 'connected' | 'unreachable'): TeamworkRead => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'ws://127.0.0.1:1/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true, url: '/srv/shop.git' },
  enrolled: true,
  links: [{ publicKey: BO, handle: 'bo', phase, since: NOW - 1_000, attempts: 1 }],
  readAt: NOW
})

const cart = (overrides: Partial<TeammateWorktree> = {}): TeammateWorktree => ({
  id: 'peer:bo:wt_1',
  handle: 'bo',
  publicKey: BO,
  name: 'cart totals',
  branch: 'cart-totals',
  state: 'ready',
  heardAt: NOW,
  live: true,
  panes: [
    { id: 'peer:bo:t_1', title: 'claude', shell: '/bin/zsh', agent: 'claude', running: true, busy: true, quietForMs: 0 }
  ],
  task: 'Fix cart totals rounding',
  stage: 'working',
  ...overrides
})

const presence = (worktrees: TeammateWorktree[], connected = true): TeammatePresenceRead => ({
  state: 'read',
  projectId: 'p1',
  worktrees,
  teammates: [{ handle: 'bo', publicKey: BO, connected, heardAt: NOW - 3 * 60_000 }],
  readAt: NOW
})

const handoff = (): PeerHandoff => ({
  id: 'h1',
  to: 'ana',
  from: 'bo',
  worktreeName: 'payment retry',
  branch: 'payment-retry',
  note: 'needs a test',
  at: NOW - 60_000
})

const closeTeamwork = vi.fn()
const openWorktree = vi.fn()
const toggleWatchedPane = vi.fn()
const answerTeammatePane = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'shop', path: '/repos/shop', baseRef: 'origin/main' }],
      members: { p1: roster() },
      teamwork: { p1: status('connected') },
      teammates: { p1: presence([cart()]) },
      closeTeamwork,
      openWorktree,
      toggleWatchedPane,
      answerTeammatePane,
      ...overrides
    },
    true
  )
}

const home = (): void => {
  render(<TeamHome projectId="p1" />)
}

const invite = (props: Partial<React.ComponentProps<typeof TeamInviteActions>> = {}): void => {
  render(<TeamInviteActions invite="Join shop on teamree: https://teamree.us/join#v=1" onCopy={vi.fn()} {...props} />)
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name })

beforeEach(() => {
  for (const mock of [call, closeTeamwork, openWorktree, toggleWatchedPane, answerTeammatePane]) mock.mockReset()
  call.mockResolvedValue(undefined)
  seed()
  teamMemory.taken.clear()
  teamMemory.landedAt.clear()
  teamMemory.startedAt.clear()
  teamMemory.finishedAt.clear()
  useHandoffs.setState({ byProject: {} })
  useReviewRequests.setState({ byProject: {} })
  useTeammateReview.setState({ open: [], batch: {} })
  useSharedNotes.setState({ inbox: [], bodies: {}, deleting: {}, expanded: null })
})

describe('the members', () => {
  it('lists you and each teammate with presence and what their agents are doing', () => {
    home()
    const members = within(region('Members'))
    const rows = members.getAllByRole('listitem').filter((row) => row.classList.contains('team-member'))
    expect(rows.map((row) => row.querySelector('.team-member__handle')?.textContent)).toEqual(['ana', 'bo'])
    expect(rows[0]?.textContent).toContain('you')
    expect(rows[1]?.textContent).toContain('online')
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: /cart totals/ }).textContent).toContain('working')
  })

  it('says when an away teammate was last seen', () => {
    seed({ teamwork: { p1: status('unreachable') }, teammates: { p1: presence([cart({ live: false })], false) } })
    // Never seen online by this window: the age of their last picture stands in.
    teamMemory.lastOnline.clear()
    home()
    expect(within(region('Members')).getByText('away · last seen 3m ago')).toBeTruthy()
  })

  it('opens a teammate’s worktree by watching its first pane, off this page', () => {
    home()
    fireEvent.click(within(region('Members')).getByRole('button', { name: /cart totals/ }))
    expect(closeTeamwork).toHaveBeenCalled()
    expect(toggleWatchedPane).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ terminalId: 'peer:bo:t_1', handle: 'bo' })
    )
  })

  it('opens your own worktree where its agents run', () => {
    const worktree = { id: 'wt_a', projectId: 'p1', name: 'search', branch: 'search', state: 'ready' } as Worktree
    const pane = {
      id: 't1',
      worktreeId: 'wt_a',
      title: 'claude',
      cwd: '/x',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      running: true,
      busy: true,
      lastOutputAt: NOW,
      agent: 'claude'
    } as Terminal
    seed({ worktrees: [worktree], terminals: { t1: pane } })
    home()
    fireEvent.click(within(region('Members')).getByRole('button', { name: /search/ }))
    expect(openWorktree).toHaveBeenCalledWith('wt_a')
  })

  it('draws what each worktree is doing as a pill in that state’s tone', () => {
    home()
    const pill = within(region('Members')).getByText('working').closest('.status-pill')
    expect(pill?.classList.contains('status--working')).toBe(true)
  })

  it('names the project and the ref new work starts from beside the team', () => {
    home()
    const card = within(region('Project'))
    expect(card.getByText('shop')).toBeTruthy()
    expect(card.getByText('origin/main')).toBeTruthy()
  })

  it('says in one line that nobody else is on the team yet', () => {
    seed({ members: { p1: roster(false) }, teammates: { p1: presence([]) } })
    home()
    expect(within(region('Members')).getByText('No teammates yet')).toBeTruthy()
  })
})

describe('what is waiting on you', () => {
  it('offers a handoff to take or dismiss, under its own head', async () => {
    useHandoffs.setState({ byProject: { p1: { incoming: [handoff()], outgoing: [] } } })
    call.mockImplementation(async (method: string) => (method === 'teamwork.take' ? { id: 'wt_taken' } : undefined))
    home()
    // Nothing is asking, so the offer is the only thing waiting and has the section to itself.
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
    const waiting = within(region('Handed to you'))
    expect(waiting.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(waiting.getByText('payment retry')).toBeTruthy()
    expect(waiting.getByText(/bo handed this to you/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(waiting.getByRole('button', { name: 'Take' }))
    })
    expect(call).toHaveBeenCalledWith('teamwork.take', expect.objectContaining({ projectId: 'p1', id: 'h1' }))
    expect(openWorktree).toHaveBeenCalledWith('wt_taken')
    expect(teamMemory.taken.get('h1')?.handoff.worktreeName).toBe('payment retry')
  })

  it('offers Allow and Open on a teammate’s asking agent, sent through their consent', () => {
    const asking = cart({
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
          menu: {
            prompt: 'fp',
            choices: [
              { label: 'Yes', keys: ['\r'] },
              { label: 'No', keys: ['\u001b'] }
            ]
          }
        }
      ]
    })
    seed({ teammates: { p1: presence([asking]) } })
    home()
    const waiting = within(region('Waiting on you'))
    expect(waiting.getByText('asking').closest('.status-pill')?.classList.contains('status--asking')).toBe(true)
    expect(waiting.queryByRole('button', { name: 'No' })).toBeNull()
    fireEvent.click(waiting.getByRole('button', { name: 'Allow' }))
    expect(answerTeammatePane).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ terminalId: 'peer:bo:t_1' }),
      expect.objectContaining({ label: 'Yes' })
    )
    fireEvent.click(waiting.getByRole('button', { name: 'Open' }))
    expect(toggleWatchedPane).toHaveBeenCalledWith('p1', expect.objectContaining({ terminalId: 'peer:bo:t_1' }))
    // The same two sit on the member's row, beside the worktree that asks.
    const members = within(region('Members'))
    expect(members.queryByRole('button', { name: 'No' })).toBeNull()
    fireEvent.click(members.getByRole('button', { name: 'Allow' }))
    expect(answerTeammatePane).toHaveBeenCalledTimes(2)
    fireEvent.click(members.getByRole('button', { name: 'Open' }))
    expect(toggleWatchedPane).toHaveBeenCalledTimes(2)
  })

  it('lists a review asked of you, moves it to Reviewing once opened, and puts it off on Later', () => {
    const request = {
      id: 'r1',
      to: 'ana',
      from: 'bo',
      worktreeId: 'peer:bo:wt_1',
      worktreeName: 'cart totals',
      branch: 'cart-totals',
      at: NOW - 60_000
    }
    useReviewRequests.setState({ byProject: { p1: { incoming: [request], outgoing: [] } } })
    home()
    const waiting = within(region('Waiting on you'))
    expect(waiting.getByText(/Review requested by bo/)).toBeTruthy()
    fireEvent.click(waiting.getByRole('button', { name: 'Review' }))
    expect(useTeammateReview.getState().open).toEqual([
      { projectId: 'p1', worktreeId: 'peer:bo:wt_1', title: 'bo · cart totals' }
    ])
    expect(call).toHaveBeenCalledWith('teamwork.settleReviewRequest', { projectId: 'p1', id: 'r1', how: 'opened' })
    expect(within(region('Waiting on you')).getByText('Nothing waiting')).toBeTruthy()
    const reviewing = within(region('Reviewing'))
    expect(reviewing.getByText(/Asked by bo/)).toBeTruthy()
    fireEvent.click(reviewing.getByRole('button', { name: 'Open' }))
    expect(useTeammateReview.getState().open).toHaveLength(1)
    fireEvent.click(reviewing.getByRole('button', { name: 'Later' }))
    expect(call).toHaveBeenCalledWith('teamwork.settleReviewRequest', { projectId: 'p1', id: 'r1', how: 'later' })
    expect(screen.queryByRole('region', { name: 'Reviewing' })).toBeNull()
  })

  it('says in one line when nothing is', () => {
    home()
    expect(within(region('Waiting on you')).getByText('Nothing waiting')).toBeTruthy()
  })
})

describe('invite and join', () => {
  it('copies the invitation with one button and opens a pasted one with the other', () => {
    const onCopy = vi.fn()
    const onPasteInvitation = vi.fn(() => null)
    invite({ onCopy, onPasteInvitation })
    fireEvent.click(screen.getByRole('button', { name: 'Copy Invitation' }))
    expect(onCopy).toHaveBeenCalledWith('Join shop on teamree: https://teamree.us/join#v=1')
    fireEvent.click(screen.getByRole('button', { name: 'Paste Invitation…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Invitation' }), {
      target: { value: 'https://teamree.us/join#v=1&origin=x' }
    })
    expect(onPasteInvitation).toHaveBeenCalledWith('https://teamree.us/join#v=1&origin=x')
  })

  it('cannot copy an invitation while there is no origin to name', () => {
    invite({ invite: null })
    expect((screen.getByRole('button', { name: 'Copy Invitation' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('notes and activity', () => {
  it('says in one line when there are no shared notes and no activity', () => {
    seed({ members: { p1: { ...roster(), members: [] } }, teammates: { p1: presence([]) } })
    home()
    expect(within(region('Shared notes')).getByText('No shared notes')).toBeTruthy()
    expect(within(region('Activity')).getByText('No activity yet')).toBeTruthy()
  })

  it('lists who did what, newest first', () => {
    useHandoffs.setState({ byProject: { p1: { incoming: [handoff()], outgoing: [] } } })
    useSharedNotes.setState({
      inbox: [
        {
          shareId: 's1',
          projectId: 'p1',
          handle: 'bo',
          publicKey: BO,
          noteId: 'n',
          title: 'Release checklist',
          sentAt: NOW,
          receivedAt: NOW - 10_000,
          seen: true,
          bytes: 3
        }
      ]
    })
    home()
    const lines = within(region('Activity'))
      .getAllByRole('listitem')
      .map((row) => row.querySelector('.team-activity__text')?.textContent)
    expect(lines.slice(0, 2)).toEqual(['bo shared Release checklist', 'bo handed you payment retry'])
    expect(lines).toContain('bo joined')
  })

  it('says the relay is unreachable in one line above the members', () => {
    seed({ teamwork: { p1: status('unreachable') }, teammates: { p1: presence([], false) } })
    home()
    expect(screen.getByText('Relay unreachable')).toBeTruthy()
  })
})
