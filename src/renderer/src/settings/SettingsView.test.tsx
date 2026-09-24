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
const { SettingsView } = await import('./SettingsView')
const { TERMINAL_OPTIONS_DEFAULT } = await import('../state/preferences')

const INITIAL = useWorkspaceStore.getState()

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
const setEditorCommand = vi.fn()
const setProjectPaths = vi.fn()
const setTerminalFontSize = vi.fn()
const setTerminalOptions = vi.fn()
const setDefaultAgent = vi.fn()
const setAgentArgs = vi.fn()
const setAutomaticUpdates = vi.fn()
const checkForUpdates = vi.fn()
const fetchInstaller = vi.fn()
const openInstaller = vi.fn()
const openTeamwork = vi.fn()
const openDialog = vi.fn()
const installCli = vi.fn()
const showAppearance = vi.fn()
const saveProjectSettings = vi.fn()

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
      setEditorCommand,
      setProjectPaths,
      setTerminalFontSize,
      setTerminalOptions,
      setDefaultAgent,
      setAgentArgs,
      setAutomaticUpdates,
      checkForUpdates,
      fetchInstaller,
      openInstaller,
      openTeamwork,
      openDialog,
      installCli,
      showAppearance,
      saveProjectSettings,
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
    setEditorCommand,
    setProjectPaths,
    setTerminalFontSize,
    setTerminalOptions,
    setDefaultAgent,
    setAgentArgs,
    setAutomaticUpdates,
    checkForUpdates,
    fetchInstaller,
    openInstaller,
    openTeamwork,
    openDialog,
    installCli,
    showAppearance,
    saveProjectSettings
  ]) {
    mock.mockReset()
  }
  seed()
})

describe('the page itself', () => {
  it('is a landmark with a name, and reads both machine facts on arrival', () => {
    render(<SettingsView />)
    expect(screen.getByRole('main', { name: 'Settings' })).toBeTruthy()
    expect(loadCli).toHaveBeenCalled()
    expect(loadUpdate).toHaveBeenCalled()
  })

  it('sits in the shared page frame, sections inside its column', () => {
    render(<SettingsView />)
    const main = screen.getByRole('main', { name: 'Settings' })
    expect(main.querySelector('.page__head h1')?.textContent).toBe('Settings')
    expect(main.querySelector('.page__body .page__column .settings__layout')).not.toBeNull()
  })

  // Opened at that section from the strip's + menu, not at the top.
  it('scrolls to the section it was opened at, once, and forgets it', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    seed({ agents: [claude, codex], settingsSection: 'agents' })
    render(<SettingsView />)
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('settings-agents'))
    expect(useWorkspaceStore.getState().settingsSection).toBeNull()
  })

  it('scrolls nowhere when opened plainly', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsView />)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('closes on Escape, which is what a reader tries first', () => {
    render(<SettingsView />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).toHaveBeenCalledTimes(1)
  })

  // A dialog is on top; one press must not close both.
  it('stands aside from Escape while a dialog is on top of it', () => {
    seed({ dialog: { kind: 'clone-project' } })
    render(<SettingsView />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  // A remote question outside `dialog`: the page must not close under its scrim.
  it('stands aside from Escape for a question nobody in this window opened', () => {
    seed({ consent: { p1: asking } })
    render(<SettingsView />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  it('has a close button as well, for the reader who never learned the key', () => {
    render(<SettingsView />)
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

  // What shapes every task first; what is set once, last.
  it('lists every section in page order, and leaves out Agents when there are none', () => {
    seed({ agents: [claude] })
    const { unmount } = render(<SettingsView />)
    expect(
      within(nav())
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Agents', 'Projects', 'Panes', 'Notifications', 'Appearance', 'Updates', 'CLI'])
    unmount()

    seed({ agents: [] })
    render(<SettingsView />)
    expect(within(nav()).queryByRole('button', { name: 'Agents' })).toBeNull()
  })

  it('scrolls to a section, focuses it and marks it current', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsView />)
    fireEvent.click(item('Panes'))
    const heading = document.getElementById('settings-panes')
    expect(scrollIntoView.mock.instances).toEqual([heading])
    expect(document.activeElement).toBe(heading)
    expect(current()).toEqual(['Panes'])
  })

  it('moves between sections with the arrow keys', () => {
    render(<SettingsView />)
    item('Panes').focus()
    fireEvent.keyDown(item('Panes'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Notifications'))
    fireEvent.keyDown(item('Notifications'), { key: 'ArrowUp' })
    fireEvent.keyDown(item('Panes'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Projects'))
    fireEvent.keyDown(item('Projects'), { key: 'End' })
    expect(document.activeElement).toBe(item('CLI'))
  })

  it('highlights the section scrolled into view', () => {
    render(<SettingsView />)
    const body = screen.getByTestId('settings-body')
    layOut({ projects: -400, panes: -200, notices: 10, appearance: 300, updates: 600, cli: 900 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['Notifications'])
    layOut({ projects: -900, panes: -700, notices: -500, appearance: -300, updates: -100, cli: 200 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['Updates'])
  })

  // The last sections cannot scroll to the top, so at the bottom the one picked wins, else the last.
  it('keeps a section picked near the end current once the page hits bottom', () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(<SettingsView />)
    const body = screen.getByTestId('settings-body')
    Object.defineProperties(body, {
      scrollTop: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 900 }
    })
    layOut({ projects: -900, panes: -700, notices: -500, appearance: -300, updates: 100, cli: 200 })
    fireEvent.click(item('Updates'))
    fireEvent.scroll(body)
    expect(current()).toEqual(['Updates'])

    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 300 })
    fireEvent.scroll(body)
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 500 })
    fireEvent.scroll(body)
    expect(current()).toEqual(['CLI'])
  })

  it('marks the section it was opened at current', () => {
    seed({ agents: [claude], settingsSection: 'agents' })
    render(<SettingsView />)
    expect(current()).toEqual(['Agents'])
  })
})

// One line of state and a button.
describe('the CLI', () => {
  const cliSection = (): HTMLElement => screen.getByRole('region', { name: 'CLI' })

  it('says where the link leads, in one line, with nothing to press', () => {
    render(<SettingsView />)
    expect(
      screen.getByText('/usr/local/bin/teamree → /Applications/teamree.app/Contents/Resources/cli/teamree')
    ).toBeTruthy()
    expect(within(cliSection()).queryByRole('button')).toBeNull()
    expect(within(cliSection()).queryByText(/leads to|on your PATH\./)).toBeNull()
  })

  it('says it is not installed, and offers Install', () => {
    seed({ cli: { ...linkedCli(), state: 'absent', resolved: null, needsAdministrator: false } })
    render(<SettingsView />)
    expect(screen.getByText('Not installed')).toBeTruthy()
    expect(within(cliSection()).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(installCli).toHaveBeenCalled()
  })

  // A path wraps at its slashes, and the words after it do not wrap mid-word.
  it('lets the path break after each slash', () => {
    seed({ cli: { ...linkedCli(), state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: false } })
    render(<SettingsView />)
    const line = screen.getByText(/another copy/)
    expect(line.querySelectorAll('wbr').length).toBe('/usr/local/bin/teamree/Volumes/old/teamree'.split('/').length - 1)
    expect(line.textContent).toBe('/usr/local/bin/teamree → /Volumes/old/teamree (another copy)')
  })

  it('says where a wrong link leads, and offers Repair', () => {
    seed({ cli: { ...linkedCli(), state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: true } })
    render(<SettingsView />)
    expect(screen.getByText('/usr/local/bin/teamree → /Volumes/old/teamree (missing)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }))
    expect(installCli).toHaveBeenCalled()
  })
})

describe('updates', () => {
  it('says this build has nothing to compare against, instead of offering a check', () => {
    seed({ update: { ...release(), current: '0.0.0-dev', checkable: false } })
    render(<SettingsView />)
    expect(screen.getByText('teamree 0.0.0-dev (not a release)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check for Updates' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Check automatically' })).toBeNull()
  })

  it('checks on request, and says when the last one was', () => {
    seed({ update: { ...release(), checkedAt: Date.now() - 4 * 60_000 } })
    render(<SettingsView />)
    expect(screen.getByText('Checked 4m ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('will not offer a second check while one is in flight', () => {
    seed({ update: { ...release(), checking: true } })
    render(<SettingsView />)
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
  })

  it('turns the automatic check off through the store', () => {
    render(<SettingsView />)
    const check = screen.getByLabelText('Check automatically')
    expect((check as HTMLInputElement).checked).toBe(true)
    fireEvent.click(check)
    expect(setAutomaticUpdates).toHaveBeenCalledWith(false)
  })

  describe('a newer release', () => {
    const available = {
      version: '1.5.0',
      tag: 'v1.5.0',
      notes: null,
      downloadUrl: 'https://github.com/zero-abd/teamree/releases/download/v1.5.0/teamree-1.5.0.dmg',
      releaseUrl: 'https://github.com/zero-abd/teamree/releases/tag/v1.5.0',
      publishedAt: null,
      installer: { name: 'teamree-1.5.0.dmg', size: 100 }
    }

    it('downloads it from the page', () => {
      seed({ update: { ...release(), available } })
      render(<SettingsView />)
      expect(screen.getByText('teamree 1.5.0 available')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      expect(fetchInstaller).toHaveBeenCalled()
    })

    it('shows progress, then opens the installer', () => {
      const downloading = { state: 'downloading' as const, version: '1.5.0', received: 30, total: 100 }
      seed({ update: { ...release(), available, download: downloading } })
      const { unmount } = render(<SettingsView />)
      expect(screen.getByRole('button', { name: 'Downloading 30%' }).hasAttribute('disabled')).toBe(true)
      unmount()

      const ready = { state: 'ready' as const, version: '1.5.0', path: '/Users/me/Downloads/teamree-1.5.0.dmg' }
      seed({ update: { ...release(), available, download: ready } })
      render(<SettingsView />)
      fireEvent.click(screen.getByRole('button', { name: 'Open Installer' }))
      expect(openInstaller).toHaveBeenCalled()
    })

    it('says in one line why a download failed', () => {
      const failed = { state: 'failed' as const, version: '1.5.0', problem: 'Checksum mismatch; the file was deleted.' }
      seed({ update: { ...release(), available, download: failed } })
      render(<SettingsView />)
      expect(screen.getByText('Checksum mismatch; the file was deleted.')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    })
  })

  it('shows why the last check answered nothing, rather than swallowing it', () => {
    seed({ update: { ...release(), problem: 'github.com could not be reached' } })
    render(<SettingsView />)
    expect(screen.getByText('github.com could not be reached')).toBeTruthy()
  })
})

describe('panes', () => {
  it('writes a new terminal text size through, under a label and no caption', () => {
    render(<SettingsView />)
    fireEvent.change(screen.getByLabelText('Terminal text size'), { target: { value: '17' } })
    expect(setTerminalFontSize).toHaveBeenCalledWith(17)
    // Every preference on this page is per-machine and none of them says so.
    expect(screen.queryByText(/Remembered on this machine only/)).toBeNull()
  })

  it('shows the size it is at, which a slider alone cannot say', () => {
    seed({ terminalFontSize: 15 })
    render(<SettingsView />)
    expect(screen.getByText('15px')).toBeTruthy()
  })

  it('previews a font as it is typed and keeps it once the field is left', () => {
    render(<SettingsView />)
    const field = screen.getByLabelText('Font') as HTMLInputElement
    expect(field.value).toBe(TERMINAL_OPTIONS_DEFAULT.fontFamily)

    fireEvent.change(field, { target: { value: 'Menlo' } })
    expect(screen.getByTestId('settings-font-preview').style.fontFamily).toBe('Menlo')
    expect(setTerminalOptions).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(setTerminalOptions).toHaveBeenCalledWith({ fontFamily: 'Menlo' })
  })

  it('sets the cursor shape and whether it blinks', () => {
    render(<SettingsView />)
    fireEvent.change(screen.getByLabelText('Cursor'), { target: { value: 'underline' } })
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorStyle: 'underline' })
    const blink = screen.getByLabelText('Blink') as HTMLInputElement
    expect(blink.checked).toBe(true)
    fireEvent.click(blink)
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('turns Option as Meta and copy on select on', () => {
    render(<SettingsView />)
    fireEvent.click(screen.getByLabelText('Option as Meta'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ optionIsMeta: true })
    fireEvent.click(screen.getByLabelText('Copy on select'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ copyOnSelect: true })
  })

  it('takes a scrollback length on Enter, and leaves the bounds to the store', () => {
    seed({ terminalOptions: { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 10_000 } })
    render(<SettingsView />)
    const field = screen.getByLabelText('Scrollback lines') as HTMLInputElement
    expect(field.value).toBe('10000')
    fireEvent.change(field, { target: { value: '25000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setTerminalOptions).toHaveBeenCalledWith({ scrollback: 25_000 })
  })
})

describe('appearance', () => {
  // The controls live in the sheet beside the panes; a page that hides them is no place to judge a theme.
  it('names the theme in effect, and opens the sheet to change it', () => {
    seed({ appearance: { ...INITIAL.appearance, mode: 'dark' }, systemTone: 'dark' })
    render(<SettingsView />)
    const section = screen.getByRole('region', { name: 'Appearance' })
    expect(within(section).queryByRole('radiogroup')).toBeNull()
    expect(within(section).getByText('Absolute Black · Dark')).toBeTruthy()
    fireEvent.click(within(section).getByRole('button', { name: 'Change…' }))
    expect(showAppearance).toHaveBeenCalledExactlyOnceWith(true)
  })
})

describe('the filter', () => {
  const filter = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Filter settings' }) as HTMLInputElement
  const type = (text: string): void => {
    fireEvent.change(filter(), { target: { value: text } })
  }
  const nav = (): string[] =>
    within(screen.getByRole('navigation', { name: 'Sections' }))
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')

  it('sits above the section list', () => {
    render(<SettingsView />)
    const list = screen.getByRole('navigation', { name: 'Sections' })
    expect(filter().compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(filter().placeholder).toBe('Filter')
  })

  it('hides every row whose label does not match, and the sections left empty', () => {
    render(<SettingsView />)
    type('cursor')
    expect(screen.getByLabelText('Cursor')).toBeTruthy()
    expect(screen.queryByLabelText('Font')).toBeNull()
    expect(screen.queryByLabelText('Setup command')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'CLI' })).toBeNull()
    expect(nav()).toEqual(['Panes'])
  })

  // What is on screen counts; an example in a tooltip does not.
  it('reads a row’s value, not the examples behind it', () => {
    const view = render(<SettingsView />)
    type('npm')
    expect(screen.getByText('No matches')).toBeTruthy()

    view.unmount()
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    render(<SettingsView />)
    type('npm')
    expect(screen.getByLabelText('Setup command').hasAttribute('data-match')).toBe(true)
    expect(screen.queryByLabelText('Copy into every new worktree')).toBeNull()
  })

  it('finds a row by the options it offers', () => {
    seed({ editors: [{ command: 'cursor', label: 'Cursor', kind: 'editor' }] })
    render(<SettingsView />)
    type('sound')
    expect(nav()).toEqual(['Notifications'])
    expect(screen.getByLabelText('When an agent stops').hasAttribute('data-match')).toBe(true)

    type('cursor')
    expect(nav()).toEqual(['Projects', 'Panes'])
    expect(screen.getByLabelText('Open checkouts in').hasAttribute('data-match')).toBe(true)
    expect(screen.getByLabelText('Cursor').hasAttribute('data-match')).toBe(false)
  })

  it('finds the theme row by any theme or mode', () => {
    seed({ appearance: { ...INITIAL.appearance, mode: 'dark' } })
    render(<SettingsView />)
    type('midnight')
    expect(nav()).toEqual(['Appearance'])
    expect(screen.getByRole('button', { name: 'Change…' }).hasAttribute('data-match')).toBe(true)

    type('dark')
    expect(nav()).toEqual(['Appearance'])
    expect(screen.getByText('Dark', { selector: 'mark' })).toBeTruthy()
  })

  it('marks the words it matched in a label', () => {
    render(<SettingsView />)
    type('on sel')
    const label = document.querySelector('label[for="settings-copy-on-select"]') as HTMLElement
    expect(label.querySelector('mark')?.textContent).toBe('on sel')
    expect(label.textContent).toBe('Copy on select')
  })

  it('keeps a whole section whose title matches', () => {
    render(<SettingsView />)
    type('updates')
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Check automatically' })).toBeTruthy()
    expect(nav()).toEqual(['Updates'])
  })

  it('finds a project row under its project, and every row by the project’s name', () => {
    render(<SettingsView />)
    type('symlink')
    expect(screen.getByRole('heading', { name: 'pager' })).toBeTruthy()
    expect(screen.getByLabelText('Symlink into every new worktree')).toBeTruthy()
    expect(screen.queryByLabelText('Setup command')).toBeNull()

    type('pager')
    expect(screen.getByLabelText('Setup command')).toBeTruthy()
  })

  it('finds an agent by its name', () => {
    seed({ agents: [claude, codex] })
    render(<SettingsView />)
    type('codex')
    expect(screen.getByLabelText('Codex')).toBeTruthy()
    expect(screen.queryByLabelText('Claude Code')).toBeNull()
    // It offers Codex.
    expect(screen.getByLabelText('Default agent').hasAttribute('data-match')).toBe(true)
  })

  it('shows everything again once cleared', () => {
    render(<SettingsView />)
    type('cursor')
    type('')
    expect(nav()).toEqual(['Projects', 'Panes', 'Notifications', 'Appearance', 'Updates', 'CLI'])
  })

  // Escape empties a filter before it closes the page.
  it('clears on Escape, and only then lets Escape close the page', () => {
    render(<SettingsView />)
    type('cursor')
    fireEvent.keyDown(filter(), { key: 'Escape' })
    expect(filter().value).toBe('')
    expect(toggleSettings).not.toHaveBeenCalled()
    fireEvent.keyDown(filter(), { key: 'Escape' })
    expect(toggleSettings).toHaveBeenCalledOnce()
  })
})

describe('projects', () => {
  it('says so in a sentence when there are none, rather than showing an empty list', () => {
    seed({ projects: [], relays: {} })
    render(<SettingsView />)
    expect(screen.getByText(/No repositories yet/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Relay' })).toBeNull()
  })

  it('reveals the repository at its own path, named so the notice can say what failed', () => {
    render(<SettingsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(revealInFinder).toHaveBeenCalledWith('/repos/pager', 'the pager repository')
  })

  // An example in the field reads as a value: a fresh project would look set to run `npm ci`.
  it('shows None in an empty list or command field, with the examples in its tooltip', () => {
    seed({ agents: [claude] })
    render(<SettingsView />)
    for (const [label, example] of [
      ['Symlink into every new worktree', 'node_modules'],
      ['Copy into every new worktree', '.env'],
      ['Setup command', 'npm ci']
    ] as const) {
      const field = screen.getByLabelText(label)
      expect(field.getAttribute('placeholder'), label).toBe('None')
      expect(field.getAttribute('title'), label).toContain(example)
    }
  })
})

describe('fetching in the background', () => {
  it('is on for a project that never said otherwise, and turns off for that project alone', () => {
    render(<SettingsView />)
    const box = screen.getByLabelText('Fetch in Background') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { fetchInBackground: false })
  })

  it('reads off, and turns back on, for a project that turned it off', () => {
    seed({ projects: [{ ...project, fetchInBackground: false }] })
    render(<SettingsView />)
    const box = screen.getByLabelText('Fetch in Background') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { fetchInBackground: true })
  })
})

describe('what a new worktree carries over from the primary checkout', () => {
  it('writes one list per line, dropping blanks, when the field is left', () => {
    render(<SettingsView />)
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.change(field, { target: { value: 'node_modules\n\n  .venv  \n' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: ['node_modules', '.venv'] })
  })

  it('keeps the two lists apart', () => {
    seed({ projects: [{ ...project, linkedPaths: ['node_modules'], copiedPaths: ['.env'] }] })
    render(<SettingsView />)
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
    render(<SettingsView />)
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.blur(field)
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: [] })
  })

  it('saves the setup command through the same method, trimmed, when the field is left', () => {
    render(<SettingsView />)
    const field = screen.getByLabelText('Setup command')
    fireEvent.change(field, { target: { value: '  npm ci  ' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: 'npm ci' })
  })

  it('shows the stored command, and writes an empty one when it is emptied', () => {
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    render(<SettingsView />)
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
  const change = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
  }

  // The value in effect as text, not a field that looks filled in.
  it('shows the ref in effect as text, with Change beside it', () => {
    render(<SettingsView />)
    const row = screen.getByText('Start new worktrees from').closest('.settings-field') as HTMLElement
    expect(within(row).getByText('origin/main')).toBeTruthy()
    expect(within(row).queryByRole('textbox')).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Use origin/main' })).toBeNull()
  })

  it('commits what was typed when the field is left', () => {
    render(<SettingsView />)
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'develop' } })
    expect(setStartPointDefault).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', 'develop')
    expect(screen.queryByLabelText('Start new worktrees from')).toBeNull()
  })

  it('commits on Enter too, for the reader who never leaves the keyboard', () => {
    render(<SettingsView />)
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: 'release/2026' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', 'release/2026')
  })

  it('puts the field away on Escape and keeps nothing', () => {
    render(<SettingsView />)
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: 'develop' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByLabelText('Start new worktrees from')).toBeNull()
    expect(setStartPointDefault).not.toHaveBeenCalled()
    expect(toggleSettings).not.toHaveBeenCalled()
  })

  it('shows a ref set here, and offers the base ref back', () => {
    seed({ startPointDefaults: { p1: 'develop' } })
    render(<SettingsView />)
    expect(screen.getByText('develop')).toBeTruthy()
    // Null, not '': `withStartPoint` removes the entry for null.
    fireEvent.click(screen.getByRole('button', { name: 'Use origin/main' }))
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  it('passes null when the field is emptied and left, the same as the button', () => {
    seed({ startPointDefaults: { p1: 'develop' } })
    render(<SettingsView />)
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  // The buttons name the ref they would use; no paragraph under them.
  it('captions the start point with nothing at all', () => {
    render(<SettingsView />)
    expect(screen.queryByText(/What the New task dialog offers first/)).toBeNull()
  })
})

describe('the app a project opens in', () => {
  const INSTALLED = [
    { command: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor' as const },
    { command: 'dev.zed.Zed', label: 'Zed', kind: 'editor' as const },
    { command: 'com.googlecode.iterm2', label: 'iTerm', kind: 'terminal' as const },
    { command: 'com.apple.finder', label: 'Finder', kind: 'finder' as const }
  ]
  const picker = (): HTMLSelectElement => screen.getByLabelText('Open checkouts in')

  it('offers the editors found, and saves the one picked', () => {
    seed({ editors: INSTALLED })
    render(<SettingsView />)

    expect([...picker().options].map((option) => option.text)).toEqual([
      'First found (VS Code)',
      'VS Code',
      'Zed',
      'Other…'
    ])
    fireEvent.change(picker(), { target: { value: 'dev.zed.Zed' } })
    expect(setEditorCommand).toHaveBeenCalledWith('p1', 'dev.zed.Zed')
  })

  it('clears the pick with First found', () => {
    seed({ editors: INSTALLED, editorCommands: { p1: 'dev.zed.Zed' } })
    render(<SettingsView />)

    expect(picker().value).toBe('dev.zed.Zed')
    fireEvent.change(picker(), { target: { value: '' } })
    expect(setEditorCommand).toHaveBeenCalledWith('p1', null)
  })

  it('takes any program by name under Other', () => {
    seed({ editors: INSTALLED })
    render(<SettingsView />)

    expect(screen.queryByLabelText('Editor command')).toBeNull()
    fireEvent.change(picker(), { target: { value: 'other' } })
    const field = screen.getByLabelText('Editor command')
    fireEvent.change(field, { target: { value: ' mate ' } })
    fireEvent.blur(field)
    expect(setEditorCommand).toHaveBeenCalledWith('p1', 'mate')
  })

  it('shows a program this project names in the field', () => {
    seed({ editors: INSTALLED, editorCommands: { p1: 'mate' } })
    render(<SettingsView />)

    expect(picker().value).toBe('other')
    expect((screen.getByLabelText('Editor command') as HTMLInputElement).value).toBe('mate')
  })

  it('says nothing about PATH', () => {
    seed({ editors: [] })
    render(<SettingsView />)

    expect([...picker().options].map((option) => option.text)).toEqual(['First found', 'Other…'])
    expect(screen.queryByText(/PATH/)).toBeNull()
  })
})

describe('the relay a project meets on', () => {
  it('reads it, and names where the URL in effect came from', () => {
    render(<SettingsView />)
    expect(loadRelay).toHaveBeenCalledWith('p1')
    expect(screen.getByText('wss://relay.example/v1/relay')).toBeTruthy()
    expect(screen.getByText('From .teamree/relay')).toBeTruthy()
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
    render(<SettingsView />)
    const block = within(relayBlock())
    expect(
      block.getByText(/TEAMREE_RELAY_URL=wss:\/\/tunnel\.example\/v1\/relay overrides \.teamree\/relay/)
    ).toBeTruthy()
  })

  it('offers no field to edit the relay, and sends the reader where one is set', () => {
    render(<SettingsView />)
    const block = relayBlock()
    expect(block.querySelectorAll('input')).toHaveLength(0)
    expect(block.querySelectorAll('textarea')).toHaveLength(0)
    fireEvent.click(within(block).getByRole('button', { name: 'Open Teamwork' }))
    expect(openTeamwork).toHaveBeenCalledWith('p1')
  })

  it('says None in the secondary colour rather than a blank line or a bold sentence', () => {
    seed({
      relays: {
        p1: {
          ...relay(),
          url: null,
          source: null,
          problem: 'no .teamree/relay',
          onDisk: { url: null, problem: 'no .teamree/relay' }
        }
      }
    })
    render(<SettingsView />)
    const block = within(relayBlock())
    expect(block.getByText('None').className).toBe('settings-fact settings-fact--none')
    expect(block.queryByText(/No \.teamree\/relay/)).toBeNull()
  })
})

// The two per-machine agent preferences, and the command line composed by the runtime's own function.
describe('the agent you always use', () => {
  it('offers the installed agents, and first-found as the way to mean no preference', () => {
    seed({ agents: [claude, codex] })
    render(<SettingsView />)

    const select = screen.getByLabelText('Default agent') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'claude', 'codex'])
    expect([...select.options].map((option) => option.textContent)).toEqual(['First found', 'Claude Code', 'Codex'])

    fireEvent.change(select, { target: { value: 'codex' } })
    expect(setDefaultAgent).toHaveBeenCalledWith('codex')
  })

  it('shows the full command under an agent given arguments, verbatim', () => {
    seed({ agents: [claude, codex], agentArgs: { claude: '--model opus' } })
    render(<SettingsView />)

    const section = screen.getByRole('heading', { name: 'Agents' }).parentElement as HTMLElement
    expect([...section.querySelectorAll('code')].map((node) => node.textContent)).toEqual(['claude --model opus'])
  })

  // `None` read as "no command" beside the command New task runs.
  it('shows the command an untouched agent runs in its empty field, and nothing under it', () => {
    seed({ agents: [claude, { ...codex, command: 'codex-cli' }] })
    render(<SettingsView />)
    expect((screen.getByLabelText('Claude Code') as HTMLInputElement).placeholder).toBe('claude')
    expect((screen.getByLabelText('Codex') as HTMLInputElement).placeholder).toBe('codex-cli')
    expect(screen.queryByText('None')).toBeNull()
    const section = screen.getByRole('heading', { name: 'Agents' }).parentElement as HTMLElement
    expect(section.querySelectorAll('code')).toHaveLength(0)
  })

  it('says Not found under an agent it has arguments for that is no longer on PATH', () => {
    seed({ agents: [claude], agentsProbed: true, agentArgs: { codex: '--full-auto' } })
    const view = render(<SettingsView />)
    const field = screen.getByLabelText('Codex') as HTMLInputElement
    expect(field.value).toBe('--full-auto')
    const caption = screen.getByText('Not found')
    expect(caption.className).toContain('settings-launch--missing')
    expect(screen.queryByText('codex --full-auto')).toBeNull()

    // Before the probe answers, nothing is known to be missing.
    view.unmount()
    seed({ agents: [claude], agentsProbed: false, agentArgs: { codex: '--full-auto' } })
    render(<SettingsView />)
    expect(screen.queryByLabelText('Codex')).toBeNull()
  })

  // The names New task uses, with the mark; the field says what it takes.
  it('names each agent the way New task does, beside a field for extra arguments', () => {
    seed({ agents: [claude, codex] })
    render(<SettingsView />)
    for (const name of ['Claude Code', 'Codex']) {
      const field = screen.getByLabelText(name) as HTMLInputElement
      expect(field.title).toBe('Extra arguments')
      const label = document.querySelector(`label[for="${field.id}"]`)
      expect(label?.querySelector('.agent-glyph')).not.toBeNull()
    }
  })

  it('shows the command changing as it is typed, before anything is committed', () => {
    seed({ agents: [claude] })
    render(<SettingsView />)

    fireEvent.change(screen.getByLabelText('Claude Code'), { target: { value: '--permission-mode plan' } })
    expect(screen.getByText('claude --permission-mode plan')).toBeTruthy()
    expect(setAgentArgs).not.toHaveBeenCalled()

    fireEvent.blur(screen.getByLabelText('Claude Code'))
    expect(setAgentArgs).toHaveBeenCalledWith('claude', '--permission-mode plan')
  })

  // Null, as with the start point above.
  it('clears an agent’s arguments rather than storing an empty string', () => {
    seed({ agents: [claude], agentArgs: { claude: '--model opus' } })
    render(<SettingsView />)

    const field = screen.getByLabelText('Claude Code')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setAgentArgs).toHaveBeenCalledWith('claude', null)
  })

  it('gives its select the same style as every other select in the app', () => {
    seed({ agents: [claude] })
    render(<SettingsView />)
    for (const select of document.querySelectorAll('select')) {
      expect(select.className).toBe('select__input')
      expect(select.parentElement?.className).toBe('select')
      expect(select.parentElement?.querySelector('.select__chevron svg')).not.toBeNull()
    }
    expect(document.querySelectorAll('select').length).toBeGreaterThanOrEqual(3)
  })

  // Every control in the section is about an agent this machine has.
  it('is not on the page at all when the machine has no agent', () => {
    seed({ agents: [] })
    render(<SettingsView />)
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull()
  })
})

describe('setup shared through .teamree/project.json', () => {
  /** The source line under a field: its chip and, for an override, Reset. */
  const sourceOf = (label: string): HTMLElement =>
    screen.getByLabelText(label).closest('.settings-field')?.querySelector('.settings-source') as HTMLElement

  it('shows the repository’s value with a Repository chip and nothing to reset', () => {
    seed({ projects: [{ ...project, repository: { setupCommand: 'npm ci', copiedPaths: ['.env'] } }] })
    render(<SettingsView />)
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('npm ci')
    expect((screen.getByLabelText('Copy into every new worktree') as HTMLTextAreaElement).value).toBe('.env')
    expect(within(sourceOf('Setup command')).getByText('Repository')).toBeTruthy()
    expect(within(sourceOf('Setup command')).queryByRole('button', { name: 'Reset' })).toBeNull()
  })

  it('marks a value set here as This Mac, and Reset hands it back to the repository', () => {
    seed({ projects: [{ ...project, setupCommand: 'pnpm i', repository: { setupCommand: 'npm ci' } }] })
    render(<SettingsView />)
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm i')
    const source = within(sourceOf('Setup command'))
    expect(source.getByText('This Mac')).toBeTruthy()
    fireEvent.click(source.getByRole('button', { name: 'Reset' }))
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: '' })
  })

  it('shows the repository’s command again when the field is emptied', () => {
    seed({ projects: [{ ...project, setupCommand: 'pnpm i', repository: { setupCommand: 'npm ci' } }] })
    render(<SettingsView />)
    const field = screen.getByLabelText('Setup command') as HTMLInputElement
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: '' })
    expect(field.value).toBe('npm ci')
  })

  it('says nothing about a source for a value the repository does not carry', () => {
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    render(<SettingsView />)
    expect(sourceOf('Setup command')).toBeNull()
  })

  it('writes the file with Save to Repository, a secondary button', () => {
    render(<SettingsView />)
    const save = screen.getByRole('button', { name: 'Save to Repository' })
    expect(save.className).not.toContain('button--primary')
    fireEvent.click(save)
    expect(saveProjectSettings).toHaveBeenCalledWith('p1')
  })

  it('says in one line when the file cannot be read', () => {
    seed({ projects: [{ ...project, repositoryProblem: 'project.json unreadable' }] })
    render(<SettingsView />)
    expect(screen.getByText('project.json unreadable')).toBeTruthy()
  })

  it('starts worktrees from the repository’s ref when this Mac has not chosen one', () => {
    seed({ projects: [{ ...project, repository: { startFrom: 'origin/dev' } }] })
    render(<SettingsView />)
    expect(screen.getByText('origin/dev')).toBeTruthy()
  })
})
