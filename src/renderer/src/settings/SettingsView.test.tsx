/** @vitest-environment jsdom */

// The settings page, tested for the promises it makes rather than its markup.
//
// Four of these are about the page being honest instead of merely present. It
// must say that an environment variable is beating the repository, because a
// relay block that showed the winning URL and nothing else is how somebody ends
// up editing a file that is being ignored. It must not offer a relay field at
// all, because the teamwork page is where a relay is set and pushed, and a
// second field here would let somebody do a third of that and stop. It must say
// that a development build has nothing to compare itself against, rather than
// offering a check that can only come back empty. And clearing a start point
// must pass null rather than an empty string, because the store treats those
// differently on purpose.
//
// The other two are about the page being usable: a control that does not write
// through leaves a page that looks identical and does nothing, and a view with
// no Escape is a view people hunt for a way out of.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatus, InstalledAgent, PaneConsent, Project, RelaySetting, UpdateState } from '@shared/entities'

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
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { SettingsView } = await import('./SettingsView')

const INITIAL = useWorkspaceStore.getState()
const modifier = resolvePlatformModifier('darwin')

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }
/**
 * A teammate's held keystrokes, waiting on this machine's owner to answer.
 *
 * Not in `dialog`: nobody in this window opened it, and it is the one modal
 * here that refuses to be dismissed. See `dialogs/modalLayer.ts`.
 */
const asking: PaneConsent = {
  projectId: 'p1',
  requests: [
    {
      id: 'c1',
      projectId: 'p1',
      terminalId: 't1',
      handle: 'sam',
      publicKey: 'k',
      since: 1,
      at: 2,
      expiresAt: Number.MAX_SAFE_INTEGER,
      writes: 3,
      bytes: 9,
      preview: 'rm -rf .',
      clipped: false
    }
  ],
  standing: [],
  readAt: 2
}

const linkedCli = (): CliStatus => ({
  installable: true,
  platform: 'darwin',
  source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
  packaged: true,
  bundle: '/Applications/teamree.app/Contents/Resources/cli/index.js',
  impermanent: null,
  destination: '/usr/local/bin/teamree',
  directory: '/usr/local/bin',
  state: 'linked',
  resolved: '/Applications/teamree.app/Contents/Resources/cli/teamree',
  dangling: false,
  needsAdministrator: true,
  onPath: 'login',
  askedAt: null,
  readAt: 0
})

const release = (): UpdateState => ({
  current: '1.4.0',
  checkable: true,
  automatic: true,
  available: null,
  checking: false,
  checkedAt: null,
  problem: null
})

const relay = (): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  onDisk: { url: 'wss://relay.example/v1/relay', problem: null },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  deploy: { command: '/Applications/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null },
  readAt: 0
})

const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }

const toggleSettings = vi.fn()
const loadCli = vi.fn()
const loadUpdate = vi.fn()
const loadRelay = vi.fn()
const revealInFinder = vi.fn()
const setStartPointDefault = vi.fn()
const setProjectPaths = vi.fn()
const setTerminalFontSize = vi.fn()
const setDefaultAgent = vi.fn()
const setAgentArgs = vi.fn()
const setAutomaticUpdates = vi.fn()
const checkForUpdates = vi.fn()
const openTeamwork = vi.fn()
const openDialog = vi.fn()
const installCli = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      settingsOpen: true,
      projects: [project],
      relays: { p1: relay() },
      cli: linkedCli(),
      update: release(),
      toggleSettings,
      loadCli,
      loadUpdate,
      loadRelay,
      revealInFinder,
      setStartPointDefault,
      setProjectPaths,
      setTerminalFontSize,
      setDefaultAgent,
      setAgentArgs,
      setAutomaticUpdates,
      checkForUpdates,
      openTeamwork,
      openDialog,
      installCli,
      ...overrides
    },
    true
  )
}

/** The relay block of the one project this file seeds. */
function relayBlock(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Relay' })
  const block = heading.parentElement
  expect(block, 'the relay heading should sit inside a block').not.toBeNull()
  return block as HTMLElement
}

beforeEach(() => {
  for (const mock of [
    toggleSettings,
    loadCli,
    loadUpdate,
    loadRelay,
    revealInFinder,
    setStartPointDefault,
    setProjectPaths,
    setTerminalFontSize,
    setDefaultAgent,
    setAgentArgs,
    setAutomaticUpdates,
    checkForUpdates,
    openTeamwork,
    openDialog,
    installCli
  ]) {
    mock.mockReset()
  }
  seed()
})

describe('the page itself', () => {
  it('is a landmark with a name, and reads both machine facts on arrival', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByRole('main', { name: 'Settings' })).toBeTruthy()
    expect(loadCli).toHaveBeenCalled()
    expect(loadUpdate).toHaveBeenCalled()
  })

  it('closes on Escape, which is what a reader tries first', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).toHaveBeenCalledTimes(1)
  })

  // The appearance editor this page's own row opens is a modal, and one press
  // taking both away would take more than was asked for.
  it('stands aside from Escape while a dialog is on top of it', () => {
    seed({ dialog: { kind: 'appearance' } })
    render(<SettingsView modifier={modifier} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  // The half of "something modal is on screen" that lives outside `dialog`.
  // A question raised by another machine cannot be dismissed, so a page closing
  // underneath it leaves the reader behind a scrim with no way back until they
  // have answered something they may not have seen arrive.
  it('stands aside from Escape for a question nobody in this window opened', () => {
    seed({ consent: { p1: asking } })
    render(<SettingsView modifier={modifier} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  it('has a close button as well, for the reader who never learned the key', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the panes' }))
    expect(toggleSettings).toHaveBeenCalledTimes(1)
  })
})

describe('teamree on your PATH', () => {
  it('says the link is made, in the install panel’s own words', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('teamree is on your PATH.')).toBeTruthy()
    expect(screen.getByText(/\/usr\/local\/bin\/teamree leads to this app/)).toBeTruthy()
  })

  it('offers the link where there is one to make, and presses it through', () => {
    seed({ cli: { ...linkedCli(), state: 'missing', resolved: null, needsAdministrator: false } })
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Put teamree on my PATH' }))
    expect(installCli).toHaveBeenCalled()
  })
})

describe('updates', () => {
  it('says this build has nothing to compare against, instead of offering a check', () => {
    seed({ update: { ...release(), current: '0.0.0-dev', checkable: false } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText(/Not a released version/)).toBeTruthy()
    expect(screen.getByText('This is teamree 0.0.0-dev.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('checks on request, and says when the last one was', () => {
    seed({ update: { ...release(), checkedAt: Date.now() - 4 * 60_000 } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('Last checked 4m ago.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('will not offer a second check while one is in flight', () => {
    seed({ update: { ...release(), checking: true } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
  })

  it('turns the automatic check off through the store', () => {
    render(<SettingsView modifier={modifier} />)
    const check = screen.getByRole('checkbox')
    expect((check as HTMLInputElement).checked).toBe(true)
    fireEvent.click(check)
    expect(setAutomaticUpdates).toHaveBeenCalledWith(false)
  })

  it('shows why the last check answered nothing, rather than swallowing it', () => {
    seed({ update: { ...release(), problem: 'github.com could not be reached' } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('github.com could not be reached')).toBeTruthy()
  })
})

describe('panes', () => {
  it('writes a new terminal text size through, and says it is remembered here only', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.change(screen.getByLabelText('Terminal text size'), { target: { value: '17' } })
    expect(setTerminalFontSize).toHaveBeenCalledWith(17)
    expect(screen.getByText(/Remembered on this machine only/)).toBeTruthy()
  })

  it('shows the size it is at, which a slider alone cannot say', () => {
    seed({ terminalFontSize: 15 })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('15px')).toBeTruthy()
  })
})

describe('appearance', () => {
  // One row, and it leads somewhere. A second set of swatches here would be a
  // second answer to one question.
  it('sends the reader to the editor that already exists, and edits nothing itself', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the appearance panel' }))
    expect(openDialog).toHaveBeenCalledWith({ kind: 'appearance' })

    const section = screen.getByRole('heading', { name: 'Appearance' }).parentElement as HTMLElement
    // The chord is on the button, and nothing argues for it beside it.
    expect(screen.getByRole('button', { name: 'Open the appearance panel' }).getAttribute('title')).toBe('⌘,')
    expect(section.textContent).not.toContain('There is no second copy')
    // No swatch, no colour field, nothing that writes an appearance from here.
    expect(section.querySelectorAll('input')).toHaveLength(0)
  })
})

describe('projects', () => {
  it('says so in a sentence when there are none, rather than showing an empty list', () => {
    seed({ projects: [], relays: {} })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText(/No repositories yet/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Relay' })).toBeNull()
  })

  it('reveals the repository at its own path, named so the notice can say what failed', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(revealInFinder).toHaveBeenCalledWith('/repos/pager', 'the pager repository')
  })

  it('shows the project’s base ref as the placeholder, so the box says what happens if it is left empty', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByLabelText('Start new worktrees from').getAttribute('placeholder')).toBe('origin/main')
  })
})

describe('what a new worktree carries over from the primary checkout', () => {
  it('writes one list per line, dropping blanks, when the field is left', () => {
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.change(field, { target: { value: 'node_modules\n\n  .venv  \n' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: ['node_modules', '.venv'] })
  })

  it('keeps the two lists apart', () => {
    seed({ projects: [{ ...project, linkedPaths: ['node_modules'], copiedPaths: ['.env'] }] })
    render(<SettingsView modifier={modifier} />)
    expect((screen.getByLabelText('Symlink into every new worktree') as HTMLTextAreaElement).value).toBe('node_modules')

    const copied = screen.getByLabelText('Copy into every new worktree')
    expect((copied as HTMLTextAreaElement).value).toBe('.env')
    fireEvent.change(copied, { target: { value: '.env\n.env.local' } })
    fireEvent.blur(copied)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { copiedPaths: ['.env', '.env.local'] })
  })

  // An empty field is how a list is cleared, and the store turns the empty
  // array into an absent field. Nothing is written for a field nobody edited.
  it('writes an empty list when the field is emptied, and nothing when it is not', () => {
    seed({ projects: [{ ...project, linkedPaths: ['node_modules'] }] })
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.blur(field)
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: [] })
  })
})

describe('the start point a new task is offered first', () => {
  it('commits what was typed when the field is left', () => {
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: 'develop' } })
    expect(setStartPointDefault).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', 'develop')
  })

  it('commits on Enter too, for the reader who never leaves the keyboard', () => {
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: 'release/2026' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', 'release/2026')
  })

  // Null, not the empty string: `withStartPoint` removes the entry for null and
  // an empty string would be a second spelling of "use the base ref" that
  // nothing else checks for.
  it('passes null when the preference is cleared', () => {
    seed({ startPointDefaults: { p1: 'develop' } })
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use origin/main' }))
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  it('passes null when the field is emptied and left, the same as the button', () => {
    seed({ startPointDefaults: { p1: 'develop' } })
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  it('offers nothing to clear when there is nothing set', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByRole('button', { name: 'Use origin/main' }).hasAttribute('disabled')).toBe(true)
  })

  it('says the preference only decides what the composer offers first', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText(/What the New task dialog offers first/)).toBeTruthy()
  })
})

describe('the relay a project meets on', () => {
  it('reads it, and names where the URL in effect came from', () => {
    render(<SettingsView modifier={modifier} />)
    expect(loadRelay).toHaveBeenCalledWith('p1')
    expect(screen.getByText('Teamwork dials wss://relay.example/v1/relay.')).toBeTruthy()
    expect(screen.getByText('From .teamree/relay.')).toBeTruthy()
  })

  it('says in words that the environment is overriding the repository', () => {
    seed({
      relays: {
        p1: {
          ...relay(),
          url: 'wss://tunnel.example/v1/relay',
          source: 'environment',
          override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
        }
      }
    })
    render(<SettingsView modifier={modifier} />)
    const block = within(relayBlock())
    expect(block.getByText(/TEAMREE_RELAY_URL is set to wss:\/\/tunnel\.example\/v1\/relay/)).toBeTruthy()
    expect(block.getByText(/\.teamree\/relay says wss:\/\/relay\.example\/v1\/relay/)).toBeTruthy()
    expect(block.getByText(/Unset it and relaunch teamree/)).toBeTruthy()
  })

  it('offers no field to edit the relay, and sends the reader where one is set', () => {
    render(<SettingsView modifier={modifier} />)
    const block = relayBlock()
    expect(block.querySelectorAll('input')).toHaveLength(0)
    expect(block.querySelectorAll('textarea')).toHaveLength(0)
    fireEvent.click(within(block).getByRole('button', { name: 'Open teamwork for pager' }))
    expect(openTeamwork).toHaveBeenCalledWith('p1')
  })

  it('says there is none, and why, rather than showing a blank line', () => {
    seed({
      relays: {
        p1: {
          ...relay(),
          url: null,
          source: null,
          problem: 'no .teamree/relay in this project',
          onDisk: { url: null, problem: 'no .teamree/relay in this project' }
        }
      }
    })
    render(<SettingsView modifier={modifier} />)
    const block = within(relayBlock())
    expect(block.getByText('Teamwork has no relay to dial in this repository.')).toBeTruthy()
    expect(block.getByText('no .teamree/relay in this project')).toBeTruthy()
  })
})

// The two per-machine agent preferences, and the one thing on this page that
// is neither a label nor a control: the line a pane will run. A field holding
// a fragment of a command line cannot be checked by looking at it — where the
// fragment lands is the whole question — so the page composes the line with
// the same function the runtime composes it with and shows the result.
describe('the agent you always use', () => {
  it('offers the installed agents, and first-found as the way to mean no preference', () => {
    seed({ agents: [claude, codex] })
    render(<SettingsView modifier={modifier} />)

    const select = screen.getByLabelText('Default agent') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'claude', 'codex'])

    fireEvent.change(select, { target: { value: 'codex' } })
    expect(setDefaultAgent).toHaveBeenCalledWith('codex')
  })

  it('shows the full command each agent will be launched with, verbatim', () => {
    seed({ agents: [claude, codex], agentArgs: { claude: '--model opus' } })
    render(<SettingsView modifier={modifier} />)

    const section = screen.getByRole('heading', { name: 'Agents' }).parentElement as HTMLElement
    // One line per field, in the fields' own order, so the line under a field
    // is never a line some other field explains. The agent nobody has typed
    // anything for shows the command as it stands.
    expect([...section.querySelectorAll('code')].map((node) => node.textContent)).toEqual([
      'claude --model opus',
      'codex'
    ])
  })

  it('shows the command changing as it is typed, before anything is committed', () => {
    seed({ agents: [claude] })
    render(<SettingsView modifier={modifier} />)

    fireEvent.change(screen.getByLabelText('claude'), { target: { value: '--permission-mode plan' } })
    expect(screen.getByText('claude --permission-mode plan')).toBeTruthy()
    expect(setAgentArgs).not.toHaveBeenCalled()

    fireEvent.blur(screen.getByLabelText('claude'))
    expect(setAgentArgs).toHaveBeenCalledWith('claude', '--permission-mode plan')
  })

  // Null rather than the empty string, for the same reason the start point
  // above passes null: the store treats the two differently on purpose.
  it('clears an agent’s arguments rather than storing an empty string', () => {
    seed({ agents: [claude], agentArgs: { claude: '--model opus' } })
    render(<SettingsView modifier={modifier} />)

    const field = screen.getByLabelText('claude')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setAgentArgs).toHaveBeenCalledWith('claude', null)
  })

  // Every control in the section is about an agent this machine has.
  it('is not on the page at all when the machine has no agent', () => {
    seed({ agents: [] })
    render(<SettingsView modifier={modifier} />)
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull()
  })
})
