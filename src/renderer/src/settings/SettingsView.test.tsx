/** @vitest-environment jsdom */

// The settings page's promises: say when an env var beats the repository's relay, offer no relay field,
// say a dev build has nothing to check against, clear a start point with null, write through, and
// close on Escape.

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
const { TERMINAL_OPTIONS_DEFAULT } = await import('../state/preferences')

const INITIAL = useWorkspaceStore.getState()
const modifier = resolvePlatformModifier('darwin')

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }
/** A teammate's held keystrokes; not in `dialog` and not dismissable (`dialogs/modalLayer.ts`). */
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
const setTerminalOptions = vi.fn()
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
      setTerminalOptions,
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
    setTerminalOptions,
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

  // Opened at that section from the strip's + menu, not at the top.
  it('scrolls to the section it was opened at, once, and forgets it', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    seed({ agents: [claude, codex], settingsSection: 'agents' })
    render(<SettingsView modifier={modifier} />)
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('settings-agents'))
    expect(useWorkspaceStore.getState().settingsSection).toBeNull()
  })

  it('scrolls nowhere when opened plainly', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsView modifier={modifier} />)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('closes on Escape, which is what a reader tries first', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).toHaveBeenCalledTimes(1)
  })

  // The appearance editor is a modal; one press must not close both.
  it('stands aside from Escape while a dialog is on top of it', () => {
    seed({ dialog: { kind: 'appearance' } })
    render(<SettingsView modifier={modifier} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  // A remote question outside `dialog`: the page must not close under its scrim.
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

describe('the section list', () => {
  const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Sections' })
  const item = (name: string): HTMLElement => within(nav()).getByRole('button', { name })
  const current = (): string[] =>
    within(nav())
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true')
      .map((button) => button.textContent ?? '')

  /** Lays the section headings out at these offsets from the top of the scrolling body. */
  function layOut(tops: Record<string, number>): void {
    for (const [id, top] of Object.entries(tops)) {
      const heading = document.getElementById(`settings-${id}`) as HTMLElement
      heading.getBoundingClientRect = () => ({ top }) as DOMRect
    }
  }

  it('lists every section in page order, and leaves out Agents when there are none', () => {
    seed({ agents: [claude] })
    const { unmount } = render(<SettingsView modifier={modifier} />)
    expect(
      within(nav())
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['CLI', 'Updates', 'Notifications', 'Panes', 'Agents', 'Appearance', 'Projects'])
    unmount()

    seed({ agents: [] })
    render(<SettingsView modifier={modifier} />)
    expect(within(nav()).queryByRole('button', { name: 'Agents' })).toBeNull()
  })

  it('scrolls to a section, focuses it and marks it current', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(item('Panes'))
    const heading = document.getElementById('settings-panes')
    expect(scrollIntoView.mock.instances).toEqual([heading])
    expect(document.activeElement).toBe(heading)
    expect(current()).toEqual(['Panes'])
  })

  it('moves between sections with the arrow keys', () => {
    render(<SettingsView modifier={modifier} />)
    item('Updates').focus()
    fireEvent.keyDown(item('Updates'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Notifications'))
    fireEvent.keyDown(item('Notifications'), { key: 'ArrowUp' })
    fireEvent.keyDown(item('Updates'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('CLI'))
    fireEvent.keyDown(item('CLI'), { key: 'End' })
    expect(document.activeElement).toBe(item('Projects'))
  })

  it('highlights the section scrolled into view', () => {
    render(<SettingsView modifier={modifier} />)
    const body = screen.getByTestId('settings-body')
    layOut({ cli: -400, updates: -200, notices: 10, panes: 300, appearance: 600, projects: 900 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['Notifications'])
    layOut({ cli: -900, updates: -700, notices: -500, panes: -300, appearance: -100, projects: 200 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['Appearance'])
  })

  // The last sections cannot scroll to the top, so at the bottom the one picked wins, else the last.
  it('keeps a section picked near the end current once the page hits bottom', () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(<SettingsView modifier={modifier} />)
    const body = screen.getByTestId('settings-body')
    Object.defineProperties(body, {
      scrollTop: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 900 }
    })
    layOut({ cli: -900, updates: -700, notices: -500, panes: -300, appearance: 100, projects: 200 })
    fireEvent.click(item('Appearance'))
    fireEvent.scroll(body)
    expect(current()).toEqual(['Appearance'])

    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 300 })
    fireEvent.scroll(body)
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 500 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['Projects'])
  })

  it('marks the section it was opened at current', () => {
    seed({ agents: [claude], settingsSection: 'agents' })
    render(<SettingsView modifier={modifier} />)
    expect(current()).toEqual(['Agents'])
  })
})

// One line of state and a button.
describe('the CLI', () => {
  const cliSection = (): HTMLElement => screen.getByRole('region', { name: 'CLI' })

  it('says where the link leads, in one line, with nothing to press', () => {
    render(<SettingsView modifier={modifier} />)
    expect(
      screen.getByText('/usr/local/bin/teamree → /Applications/teamree.app/Contents/Resources/cli/teamree')
    ).toBeTruthy()
    expect(within(cliSection()).queryByRole('button')).toBeNull()
    expect(within(cliSection()).queryByText(/leads to|on your PATH\./)).toBeNull()
  })

  it('says it is not installed, and offers Install', () => {
    seed({ cli: { ...linkedCli(), state: 'absent', resolved: null, needsAdministrator: false } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('Not installed')).toBeTruthy()
    expect(within(cliSection()).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(installCli).toHaveBeenCalled()
  })

  it('says where a wrong link leads, and offers Repair', () => {
    seed({ cli: { ...linkedCli(), state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: true } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('/usr/local/bin/teamree → /Volumes/old/teamree (missing)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }))
    expect(installCli).toHaveBeenCalled()
  })
})

describe('updates', () => {
  it('says this build has nothing to compare against, instead of offering a check', () => {
    seed({ update: { ...release(), current: '0.0.0-dev', checkable: false } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('teamree 0.0.0-dev (not a release)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Check automatically' })).toBeNull()
  })

  it('checks on request, and says when the last one was', () => {
    seed({ update: { ...release(), checkedAt: Date.now() - 4 * 60_000 } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('Checked 4m ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('will not offer a second check while one is in flight', () => {
    seed({ update: { ...release(), checking: true } })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
  })

  it('turns the automatic check off through the store', () => {
    render(<SettingsView modifier={modifier} />)
    const check = screen.getByLabelText('Check automatically')
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
  it('writes a new terminal text size through, under a label and no caption', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.change(screen.getByLabelText('Terminal text size'), { target: { value: '17' } })
    expect(setTerminalFontSize).toHaveBeenCalledWith(17)
    // Every preference on this page is per-machine and none of them says so.
    expect(screen.queryByText(/Remembered on this machine only/)).toBeNull()
  })

  it('shows the size it is at, which a slider alone cannot say', () => {
    seed({ terminalFontSize: 15 })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByText('15px')).toBeTruthy()
  })

  it('previews a font as it is typed and keeps it once the field is left', () => {
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Font') as HTMLInputElement
    expect(field.value).toBe(TERMINAL_OPTIONS_DEFAULT.fontFamily)

    fireEvent.change(field, { target: { value: 'Menlo' } })
    expect(screen.getByTestId('settings-font-preview').style.fontFamily).toBe('Menlo')
    expect(setTerminalOptions).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(setTerminalOptions).toHaveBeenCalledWith({ fontFamily: 'Menlo' })
  })

  it('sets the cursor shape and whether it blinks', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.change(screen.getByLabelText('Cursor'), { target: { value: 'underline' } })
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorStyle: 'underline' })
    const blink = screen.getByLabelText('Blink') as HTMLInputElement
    expect(blink.checked).toBe(true)
    fireEvent.click(blink)
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('turns Option as Meta and copy on select on', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByLabelText('Option as Meta'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ optionIsMeta: true })
    fireEvent.click(screen.getByLabelText('Copy on select'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ copyOnSelect: true })
  })

  it('takes a scrollback length on Enter, and leaves the bounds to the store', () => {
    seed({ terminalOptions: { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 10_000 } })
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Scrollback lines') as HTMLInputElement
    expect(field.value).toBe('10000')
    fireEvent.change(field, { target: { value: '25000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setTerminalOptions).toHaveBeenCalledWith({ scrollback: 25_000 })
  })
})

describe('appearance', () => {
  // One row that leads to the editor, no second set of swatches.
  it('sends the reader to the editor that already exists, and edits nothing itself', () => {
    render(<SettingsView modifier={modifier} />)
    fireEvent.click(screen.getByRole('button', { name: 'Appearance…' }))
    expect(openDialog).toHaveBeenCalledWith({ kind: 'appearance' })

    const section = screen.getByRole('heading', { name: 'Appearance' }).parentElement as HTMLElement
    // No chord (⌘, is this page) and no empty tooltip.
    expect(screen.getByRole('button', { name: 'Appearance…' }).getAttribute('title')).toBeNull()
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

  // An empty field clears the list (the store drops the field); untouched fields write nothing.
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

  it('saves the setup command through the same method, trimmed, when the field is left', () => {
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Setup command')
    expect(field.getAttribute('placeholder')).toBe('npm ci')
    fireEvent.change(field, { target: { value: '  npm ci  ' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: 'npm ci' })
  })

  it('shows the stored command, and writes an empty one when it is emptied', () => {
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    render(<SettingsView modifier={modifier} />)
    const field = screen.getByLabelText('Setup command') as HTMLInputElement
    expect(field.value).toBe('npm ci')

    fireEvent.blur(field)
    expect(setProjectPaths).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: '' })
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

  // Null, not '': `withStartPoint` removes the entry for null.
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

  // The buttons name the ref they would use; no paragraph under them.
  it('captions the start point with nothing at all', () => {
    render(<SettingsView modifier={modifier} />)
    expect(screen.queryByText(/What the New task dialog offers first/)).toBeNull()
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

// The two per-machine agent preferences, and the command line composed by the runtime's own function.
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
    // One line per field in field order; an untouched agent shows the command as it stands.
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

  // Null, as with the start point above.
  it('clears an agent’s arguments rather than storing an empty string', () => {
    seed({ agents: [claude], agentArgs: { claude: '--model opus' } })
    render(<SettingsView modifier={modifier} />)

    const field = screen.getByLabelText('claude')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setAgentArgs).toHaveBeenCalledWith('claude', null)
  })

  it('gives its select the same style as every other select on the page', () => {
    seed({ agents: [claude] })
    render(<SettingsView modifier={modifier} />)
    expect(screen.getByLabelText('Default agent').className).toBe(
      screen.getByLabelText('When an agent stops').className
    )
  })

  // Every control in the section is about an agent this machine has.
  it('is not on the page at all when the machine has no agent', () => {
    seed({ agents: [] })
    render(<SettingsView modifier={modifier} />)
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull()
  })
})
