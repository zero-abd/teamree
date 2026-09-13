/** @vitest-environment jsdom */

// The teamwork setup as a place in the window rather than a box over it.
//
// What the steps say is covered by `TeamworkSteps.test.tsx` and by the model's
// own tests. This is about the three things that changed when it stopped being
// a modal: that it is a landmark somebody can be sent to and land in, that it
// has a way out that does not depend on clicking beside it, and that the wall
// of four relays is now one recommendation, one fallback, and a button.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberList, Project, RelaySetting } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { TeamworkView } = await import('./TeamworkView')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }

const SELF_KEY = 'c2VsZmtleXNlbGZrZXlzZWxma2V5c2VsZmtleXNlbGZrZXk='

const roster = (): MemberList => ({
  projectId: 'p1',
  members: [],
  problems: [],
  self: { handle: 'ada', publicKey: SELF_KEY },
  selfFile: '.teamree/members/ada.pub',
  enrolled: false,
  watched: true,
  readAt: 0
})

const noRelay = (): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: null,
  source: null,
  problem: 'no .teamree/relay in this project',
  onDisk: { url: null, problem: 'no .teamree/relay in this project' },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  readAt: 0
})

const closeTeamwork = vi.fn()
const loadMembers = vi.fn()
const loadRelay = vi.fn()
const loadTeamwork = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      members: { p1: roster() },
      relays: { p1: noRelay() },
      closeTeamwork,
      loadMembers,
      loadRelay,
      loadTeamwork,
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<TeamworkView projectId="p1" />)
}

beforeEach(() => {
  closeTeamwork.mockReset()
  loadMembers.mockReset()
  loadRelay.mockReset()
  loadTeamwork.mockReset()
  seed()
})

describe('the setup as a place in the window', () => {
  // A modal is named by the box; this is named by the area it fills, which is
  // what lets somebody sent here by a sidebar button know where they landed.
  it('is a landmark that names the repository it is setting up', () => {
    mount()
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Start teamwork' })).toBeTruthy()
  })

  // Reached from a button somewhere else in the window, so the keyboard has to
  // come with it: without this, Tab walks the sidebar it was opened from.
  it('takes the focus when it opens, so the keyboard is in it', () => {
    mount()
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Set up teamwork in pager' }))
  })

  it('reads the roster, the relay and the links when it opens', () => {
    mount()
    expect(loadMembers).toHaveBeenCalledWith('p1')
    expect(loadRelay).toHaveBeenCalledWith('p1')
    expect(loadTeamwork).toHaveBeenCalledWith('p1')
  })

  it('has a way out that is a control, and one that is the key everybody tries', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(closeTeamwork).toHaveBeenCalledOnce()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeTeamwork).toHaveBeenCalledTimes(2)
  })

  // A dialog opened on top owns Escape. Closing both with one press takes away
  // more than the reader asked for.
  it('leaves Escape to a dialog opened over it', () => {
    seed({ dialog: { kind: 'new-task', projectId: 'p1' } })
    mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeTeamwork).not.toHaveBeenCalled()
  })

  it('still names the view when the project is not in the store', () => {
    seed({ projects: [] })
    mount()
    expect(screen.getByRole('main', { name: 'Set up teamwork in this repository' })).toBeTruthy()
  })
})

describe('how many ways to get a relay are put in front of somebody', () => {
  // Four options presented as equals is a decision handed to the one person in
  // the room least able to take it. relay/README.md has always said which one
  // to take; the panel says it too now.
  it('shows the one to take and the one to fall back on, and no more', () => {
    mount()
    expect(screen.getByText(/Deploy the Worker/)).toBeTruthy()
    expect(screen.getByText(/A tunnel to a relay on your own machine/)).toBeTruthy()
    expect(screen.queryByText(/A VPS you rent/)).toBeNull()
    expect(screen.queryByText(/A mesh VPN/)).toBeNull()
  })

  it('says which one is the recommendation rather than leaving it to the order', () => {
    mount()
    expect(screen.getByText('Recommended')).toBeTruthy()
  })

  // The other two are real and documented; they are behind a control that says
  // whether it is open, not deleted and not hidden in a way nothing can find.
  it('keeps the rest one keyboard-reachable press away, and says it is folded', () => {
    mount()
    const more = screen.getByRole('button', { name: 'Other ways to get a relay' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/A VPS you rent/)).toBeTruthy()
    expect(screen.getByText(/A mesh VPN/)).toBeTruthy()
    fireEvent.click(more)
    expect(screen.queryByText(/A VPS you rent/)).toBeNull()
  })

  // Somebody joining a team that already has a relay has no decision to make:
  // theirs arrives in the repository.
  it('offers none of it to somebody whose team already has one', () => {
    seed({
      relays: {
        p1: {
          ...noRelay(),
          url: 'wss://relay.example/v1/relay',
          source: 'repository',
          problem: null,
          onDisk: { url: 'wss://relay.example/v1/relay', problem: null }
        }
      }
    })
    mount()
    expect(screen.queryByText(/Deploy the Worker/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Other ways to get a relay' })).toBeNull()
  })
})
