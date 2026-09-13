/** @vitest-environment jsdom */

// The teamwork setup as a place in the window rather than a box over it.
//
// What the steps say is covered by `TeamworkSteps.test.tsx` and by the model's
// own tests. This is about the view: that it is a landmark somebody can be sent
// to and land in, that it has a way out that does not depend on clicking beside
// it, and — the part this file exists for now — that the three things that used
// to be shell commands are buttons wired to the store, each of them honest
// about what it will do and about being unable to do it.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberList, Project, RelaySetting, TeamworkPublishPlan, TeamworkStatus } from '@shared/entities'

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
  deploy: { command: '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null },
  readAt: 0
})

const noOrigin = (): TeamworkStatus => ({
  projectId: 'p1',
  relay: null,
  disabledReason: 'no .teamree/relay in this project',
  origin: { ok: false, reason: 'this project has no origin remote' },
  enrolled: false,
  links: [],
  readAt: 0
})

const plan = (overrides: Partial<TeamworkPublishPlan> = {}): TeamworkPublishPlan => ({
  projectId: 'p1',
  files: ['.teamree/members/ada.pub', '.teamree/relay'],
  message: 'Set up teamwork',
  remote: 'origin',
  branch: 'main',
  upstream: 'origin/main',
  committed: false,
  blocker: null,
  readAt: 0,
  ...overrides
})

const closeTeamwork = vi.fn()
const loadMembers = vi.fn()
const loadRelay = vi.fn()
const loadTeamwork = vi.fn()
const loadPublishPlan = vi.fn()
const setOrigin = vi.fn()
const startRelayDeploy = vi.fn()
const closeRelayDeploy = vi.fn()
const publishTeamwork = vi.fn()

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
      loadPublishPlan,
      setOrigin,
      startRelayDeploy,
      closeRelayDeploy,
      publishTeamwork,
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
  loadPublishPlan.mockReset()
  setOrigin.mockReset()
  startRelayDeploy.mockReset()
  closeRelayDeploy.mockReset()
  publishTeamwork.mockReset()
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

  it('reads the roster, the relay, the links and what the push would do when it opens', () => {
    mount()
    expect(loadMembers).toHaveBeenCalledWith('p1')
    expect(loadRelay).toHaveBeenCalledWith('p1')
    expect(loadTeamwork).toHaveBeenCalledWith('p1')
    expect(loadPublishPlan).toHaveBeenCalledWith('p1')
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
  // The recommendation is a button now, so nothing is a list of equals and
  // nothing is in front of a reader who has not asked for it.
  it('leads with the button and shows no option list at all', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Deploy a relay' })).toBeTruthy()
    expect(screen.queryByText(/A VPS you rent/)).toBeNull()
    expect(screen.queryByText(/A mesh VPN/)).toBeNull()
    expect(screen.queryByText(/A tunnel to a relay on your own machine/)).toBeNull()
  })

  // The others are real and documented; they are behind a control that says
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
    expect(screen.queryByRole('button', { name: 'Deploy a relay' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Other ways to get a relay' })).toBeNull()
  })
})

describe('the deploy, as a button rather than a command to take elsewhere', () => {
  it('starts it in a pane in this window', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Deploy a relay' }))
    expect(startRelayDeploy).toHaveBeenCalledWith('p1')
  })

  // A control that is grey for a reason nobody can read is the same as one that
  // does nothing, so the runtime's own sentence is beside it.
  it('is disabled, with the reason, when this build carries no relay to deploy', () => {
    seed({ relays: { p1: { ...noRelay(), deploy: { command: null, reason: 'this build carries no relay project' } } } })
    mount()
    const button = screen.getByRole('button', { name: 'Deploy a relay' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/this build carries no relay project/)).toBeTruthy()
  })

  // The URL is offered rather than written: a relay is a team-wide fact, and a
  // fact is somebody's to assert.
  it('offers the URL the deploy printed instead of writing it in', () => {
    const setRelay = vi.fn()
    seed({
      setRelay,
      relayDeploys: { p1: { terminalId: 'term_9', url: 'wss://ada.workers.dev/v1/relay', running: false } }
    })
    mount()
    expect(screen.getByText('wss://ada.workers.dev/v1/relay')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use this relay URL' }))
    expect(setRelay).toHaveBeenCalledWith('p1', 'wss://ada.workers.dev/v1/relay')
  })

  it('says the pane can be closed, and closes it', () => {
    seed({ relayDeploys: { p1: { terminalId: 'term_9', url: null, running: false } } })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close this pane' }))
    expect(closeRelayDeploy).toHaveBeenCalledWith('p1')
  })

  // The command still has to be readable: running it yourself is a legitimate
  // answer, and it is the only answer on a machine where the app cannot.
  it('keeps the command itself, one disclosure away', () => {
    mount()
    expect(screen.getByText('/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy')).toBeTruthy()
  })
})

describe('the origin remote, as a field rather than a command to go and run', () => {
  it('refuses a path on this disk before git is ever asked', () => {
    seed({ teamwork: { p1: noOrigin() } })
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Origin URL' }), {
      target: { value: '/Users/ada/code/pager' }
    })
    // The blocker sentence at the top says "not a path on this disk" too; this
    // is the field's own refusal, which is a different sentence.
    expect(screen.getByText(/a path is not a URL your teammates could clone/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add origin' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sets it when what is typed is a URL with a host', () => {
    seed({ teamwork: { p1: noOrigin() } })
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Origin URL' }), {
      target: { value: 'https://github.com/ada/pager.git' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add origin' }))
    expect(setOrigin).toHaveBeenCalledWith('p1', 'https://github.com/ada/pager.git')
  })

  it('shows what the runtime said when git refused, beside the field', () => {
    seed({ teamwork: { p1: noOrigin() }, originError: 'fatal: not a git repository' })
    mount()
    expect(screen.getByText('fatal: not a git repository')).toBeTruthy()
  })

  it('is not there at all for a checkout whose origin is fine', () => {
    mount()
    expect(screen.queryByRole('textbox', { name: 'Origin URL' })).toBeNull()
  })
})

/** Step 4's own card, so an assertion about it cannot be answered by step 3. */
const pushStep = (): HTMLElement => {
  const step = screen.getByRole('heading', { name: '4. Commit and push' }).closest('li')
  if (step === null) throw new Error('step 4 is not in a list item')
  return step
}

describe('committing and pushing, which is the one that leaves the machine', () => {
  const enrolledRoster = (): MemberList => ({
    ...roster(),
    enrolled: true,
    members: [
      { handle: 'ada', publicKey: SELF_KEY, addedAt: '2026-03-01', file: '.teamree/members/ada.pub', isSelf: true }
    ]
  })

  const ready = (overrides: Record<string, unknown> = {}): void =>
    seed({
      members: { p1: enrolledRoster() },
      relays: {
        p1: {
          ...noRelay(),
          url: 'wss://relay.example/v1/relay',
          source: 'repository',
          problem: null,
          onDisk: { url: 'wss://relay.example/v1/relay', problem: null }
        }
      },
      publishPlans: { p1: plan() },
      ...overrides
    })

  // The whole of the confirmation this owes somebody, and it is on screen
  // before the button rather than behind one nobody reads.
  it('names the files, the message, the remote and the branch before it is pressed', () => {
    ready()
    mount()
    const step = within(pushStep())
    expect(step.getByText('.teamree/members/ada.pub')).toBeTruthy()
    expect(step.getByText('.teamree/relay')).toBeTruthy()
    expect(step.getByText('Set up teamwork')).toBeTruthy()
    expect(step.getByText('main')).toBeTruthy()
    expect(step.getByText(/origin \(origin\/main\)/)).toBeTruthy()
  })

  it('says when this push is what would set the upstream', () => {
    ready({ publishPlans: { p1: plan({ upstream: null }) } })
    mount()
    expect(screen.getByText(/does not track yet — this push would set it/)).toBeTruthy()
  })

  it('pushes on the button, and only then', () => {
    ready()
    mount()
    expect(publishTeamwork).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }))
    expect(publishTeamwork).toHaveBeenCalledWith('p1')
  })

  it('is disabled with the reason when the runtime says it cannot be done', () => {
    ready({
      publishPlans: {
        p1: plan({ branch: null, blocker: 'This checkout is not on a branch, so there is nothing to push.' })
      }
    })
    mount()
    expect((screen.getByRole('button', { name: 'Commit and push' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/so there is nothing to push/)).toBeTruthy()
  })

  // A commit that landed and a push that was refused is the ordinary way this
  // goes wrong, and reporting it as one failure would leave somebody believing
  // they had made no commit.
  it('reports the commit and git’s own words when the push was refused', () => {
    ready({
      publishResults: {
        p1: {
          projectId: 'p1',
          files: ['.teamree/relay'],
          commit: { sha: 'abc1234def', shortSha: 'abc1234', message: 'Set up teamwork' },
          remote: 'origin',
          branch: 'main',
          push: {
            ok: false,
            error: '! [rejected]        main -> main (fetch first)\nerror: failed to push some refs',
            advice: 'origin has commits that main does not. Pull or rebase onto origin/main and push again.'
          },
          at: 0
        }
      }
    })
    mount()
    expect(screen.getByText(/Committed abc1234/)).toBeTruthy()
    expect(screen.getByText(/Pull or rebase onto origin\/main/)).toBeTruthy()
    expect(screen.getByText(/failed to push some refs/)).toBeTruthy()
  })
})
