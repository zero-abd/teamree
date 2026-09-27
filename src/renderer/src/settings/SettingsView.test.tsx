/** @vitest-environment jsdom */

// The settings page's promises: say when an env var beats the repository's relay, offer no relay field,
// say a dev build has nothing to check against, clear a start point with null, write through, and
// close on Escape.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatus, InstalledAgent, PaneConsent, Project, RelaySetting, UpdateState } from '@shared/entities'
import { DEFAULT_RUNTIME_SETTINGS } from '@shared/settings'
import type { SettingsSectionId } from './settingsModel'

const runtimeCall = vi.hoisted(() => ({
  answer: (_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})
}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => runtimeCall.answer(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { runtimeClient } = await import('../runtimeClient/currentRuntimeClient')
const { SettingsView } = await import('./SettingsView')
const { useSettingsFind } = await import('./settingsFind')
const { useUsageStore } = await import('../state/usageStore')
const { TERMINAL_OPTIONS_DEFAULT } = await import('../state/preferences')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const MAC = resolvePlatformModifier('darwin')

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
const loadAgentTrust = vi.fn()
const setTrustNewWorktrees = vi.fn()
const checkForUpdates = vi.fn()
const fetchInstaller = vi.fn()
const openInstaller = vi.fn()
const restartToUpdate = vi.fn()
const openTeamwork = vi.fn()
const openDialog = vi.fn()
const installCli = vi.fn()
const showAppearance = vi.fn()
const saveProjectSettings = vi.fn()
const setDiffLayout = vi.fn()
const toggleDiffOption = vi.fn()
const setKeepAwake = vi.fn()
const setConfirmation = vi.fn()
const setNoticeEvent = vi.fn()
const setAgentNotices = vi.fn()

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
      loadAgentTrust,
      setTrustNewWorktrees,
      checkForUpdates,
      fetchInstaller,
      openInstaller,
      restartToUpdate,
      openTeamwork,
      openDialog,
      installCli,
      showAppearance,
      saveProjectSettings,
      setDiffLayout,
      toggleDiffOption,
      setKeepAwake,
      setConfirmation,
      setNoticeEvent,
      setAgentNotices,
      ...overrides
    },
    true
  )
}

/** The page opened at one section, the way Settings › that section opens it. */
function renderAt(section: SettingsSectionId, props: { modifier?: typeof MAC } = {}): ReturnType<typeof render> {
  useWorkspaceStore.setState({ settingsSection: section })
  return render(<SettingsView {...props} />)
}

/** Shows another section of the page already open. */
function show(label: string): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: label }))
}

/** The relay row of the one project this file seeds. */
function relayBlock(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Relay' })
  const block = heading.closest('.settings-field')
  expect(block, 'the relay heading should sit inside a row').not.toBeNull()
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
    loadAgentTrust,
    setTrustNewWorktrees,
    checkForUpdates,
    fetchInstaller,
    openInstaller,
    restartToUpdate,
    openTeamwork,
    openDialog,
    installCli,
    showAppearance,
    saveProjectSettings,
    setDiffLayout,
    toggleDiffOption,
    setKeepAwake,
    setConfirmation,
    setNoticeEvent,
    setAgentNotices
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

  it('sits in the shared page frame, its section list in the frame’s side column', () => {
    render(<SettingsView />)
    const main = screen.getByRole('main', { name: 'Settings' })
    expect(main.querySelector('.page__head h1')?.textContent).toBe('Settings')
    expect(main.querySelector('.page__side nav[aria-label="Sections"]')).not.toBeNull()
    expect(main.querySelector('.page__body .page__column .settings__content')).not.toBeNull()
  })

  // Opened at that section from the strip's + menu, not at the top.
  it('shows the section it was opened at, focuses its title, and forgets the request', () => {
    seed({ agents: [claude, codex] })
    renderAt('agents')
    expect(document.activeElement).toBe(document.getElementById('settings-agents'))
    expect(screen.queryByRole('region', { name: 'General' })).toBeNull()
    expect(useWorkspaceStore.getState().settingsSection).toBeNull()
  })

  // Opened from the rail's `!`: the row it is about is lit for a moment.
  it('lights the section it was opened at', () => {
    const animate = vi.fn()
    Element.prototype.animate = animate
    renderAt('cli')
    expect(animate).toHaveBeenCalledOnce()
    expect(animate.mock.instances[0]).toBe(screen.getByRole('region', { name: 'CLI' }).querySelector('.settings-group'))
  })

  it('opens at General, and shows one section at a time', () => {
    render(<SettingsView />)
    expect(screen.getByRole('region', { name: 'General' })).toBeTruthy()
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(document.activeElement).not.toBe(document.getElementById('settings-general'))
  })

  // Settings covers the panes, so the find chord lands in its search.
  it('takes the find chord into its search', () => {
    render(<SettingsView />)
    act(() => useSettingsFind.getState().ask())
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter settings' }))
  })

  it('draws every on/off setting as a switch', () => {
    renderAt('panes')
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(5)
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

describe('Teamwork', () => {
  it('turns Share Task Details off through the runtime, and says why when it cannot', async () => {
    const sent: unknown[] = []
    let refuse = false
    runtimeCall.answer = (method, params) => {
      if (method === 'settings.get')
        return Promise.resolve({ shareTaskDetails: true, showCost: false, jacMemoryAddon: false })
      if (method !== 'settings.set') return new Promise(() => {})
      sent.push(params)
      if (refuse) return Promise.reject(new Error('the workspace file is read-only'))
      return Promise.resolve({ shareTaskDetails: false, showCost: false, jacMemoryAddon: false })
    }
    try {
      renderAt('teamwork')
      const box = (await screen.findByRole('switch', { name: 'Share Task Details' })) as HTMLInputElement
      await vi.waitFor(() => expect(box.disabled).toBe(false))
      expect(box.checked).toBe(true)

      fireEvent.click(box)
      await vi.waitFor(() => expect(box.checked).toBe(false))
      expect(sent).toEqual([{ shareTaskDetails: false }])

      refuse = true
      fireEvent.click(box)
      expect(await screen.findByText('the workspace file is read-only')).toBeTruthy()
      expect(box.checked).toBe(false)
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })
})

describe('Add-ons', () => {
  const row = (): HTMLElement => screen.getByTestId('addon-jac-memory')

  it('offers Install, then the on/off box once installed, and turns it on through the runtime', async () => {
    const sent: unknown[] = []
    let status: object = { id: 'jac-memory', state: 'off' }
    runtimeCall.answer = (method, params) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS })
      if (method === 'addons.status') return Promise.resolve([status])
      if (method === 'addons.install') {
        sent.push(params)
        status = { id: 'jac-memory', state: 'running', version: '0.1.0' }
        return Promise.resolve(status)
      }
      if (method === 'settings.set') {
        sent.push(params)
        return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS, ...(params as object) })
      }
      return new Promise(() => {})
    }
    try {
      renderAt('addons')
      fireEvent.click(await within(row()).findByRole('button', { name: 'Install' }))
      await within(row()).findByText('Running 0.1.0')
      expect(sent).toEqual([{ id: 'jac-memory' }])
      const box = within(row()).getByRole('switch') as HTMLInputElement
      expect(box.checked).toBe(true)
      fireEvent.click(box)
      await vi.waitFor(() => expect(sent).toContainEqual({ jacMemoryAddon: false }))
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('says it needs uv, links to it, and offers no Install', async () => {
    runtimeCall.answer = (method) => {
      if (method === 'addons.status') return Promise.resolve([{ id: 'jac-memory', state: 'off', needs: 'uv' }])
      return new Promise(() => {})
    }
    try {
      renderAt('addons')
      const link = await within(row()).findByRole('link', { name: 'Get uv' })
      expect(link.getAttribute('href')).toContain('docs.astral.sh/uv')
      expect(within(row()).queryByRole('button', { name: 'Install' })).toBeNull()
      expect(within(row()).getByText('Needs uv')).toBeTruthy()
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('checks for uv again on Check Again and on window focus, without a restart', async () => {
    let status: object = { id: 'jac-memory', state: 'off', needs: 'uv' }
    let reads = 0
    runtimeCall.answer = (method) => {
      if (method === 'addons.status') {
        reads += 1
        return Promise.resolve([status])
      }
      return new Promise(() => {})
    }
    try {
      renderAt('addons')
      await within(row()).findByText('Needs uv')
      status = { id: 'jac-memory', state: 'off' }
      fireEvent.click(within(row()).getByRole('button', { name: 'Check Again' }))
      await within(row()).findByRole('button', { name: 'Install' })

      status = { id: 'jac-memory', state: 'off', needs: 'uv' }
      const before = reads
      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      await within(row()).findByText('Needs uv')
      expect(reads).toBe(before + 1)
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('a failed install offers Retry and Copy Details with the whole output', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const sent: unknown[] = []
    runtimeCall.answer = (method, params) => {
      if (method === 'addons.status') {
        return Promise.resolve([
          { id: 'jac-memory', state: 'failed', detail: 'network is unreachable', output: '$ uv pip install\n× Failed' }
        ])
      }
      if (method === 'addons.install') {
        sent.push(params)
        return new Promise(() => {})
      }
      return new Promise(() => {})
    }
    try {
      renderAt('addons')
      expect(await screen.findByText('network is unreachable')).toBeTruthy()
      expect(within(row()).queryByRole('button', { name: 'Install' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Copy Details' }))
      expect(writeText).toHaveBeenCalledWith('$ uv pip install\n× Failed')
      fireEvent.click(within(row()).getByRole('button', { name: 'Retry' }))
      expect(sent).toEqual([{ id: 'jac-memory' }])
      await within(row()).findByText('Installing…')
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('shows Failed and why', async () => {
    runtimeCall.answer = (method) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS, jacMemoryAddon: true })
      if (method === 'addons.status') {
        return Promise.resolve([{ id: 'jac-memory', state: 'failed', version: '0.1.0', detail: 'timeout' }])
      }
      return new Promise(() => {})
    }
    try {
      renderAt('addons')
      expect(await within(row()).findByText('Failed')).toBeTruthy()
      expect(await screen.findByText('timeout')).toBeTruthy()
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
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

  // What shapes every task first; what is set once, last.
  it('lists every section in page order, and leaves out Agents when there are none', () => {
    seed({ agents: [claude] })
    const { unmount } = render(<SettingsView />)
    expect(
      within(nav())
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual([
      'General',
      'Agents',
      'Projects',
      'Git',
      'Panes',
      'Notifications',
      'Teamwork',
      'Appearance',
      'Shortcuts',
      'Add-ons',
      'Updates',
      'CLI'
    ])
    unmount()

    seed({ agents: [] })
    render(<SettingsView />)
    expect(within(nav()).queryByRole('button', { name: 'Agents' })).toBeNull()
  })

  it('groups the sections, each with its icon', () => {
    render(<SettingsView />)
    const groups = within(nav())
      .getAllByRole('list')
      .map((list) => list.getAttribute('aria-labelledby'))
      .map((id) => document.getElementById(id ?? '')?.textContent)
    expect(groups).toEqual(['Workspace', 'App', 'System'])
    expect(item('Git').querySelector('svg[data-icon]')).not.toBeNull()
  })

  it('shows the section picked, focuses its title and marks it current', () => {
    render(<SettingsView />)
    fireEvent.click(item('Panes'))
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual([
      'settings-panes'
    ])
    expect(document.activeElement).toBe(document.getElementById('settings-panes'))
    expect(current()).toEqual(['Panes'])
  })

  it('moves between sections with the arrow keys, showing each and keeping the focus in the list', () => {
    render(<SettingsView />)
    item('Panes').focus()
    fireEvent.keyDown(item('Panes'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Notifications'))
    expect(current()).toEqual(['Notifications'])
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy()
    fireEvent.keyDown(item('Notifications'), { key: 'ArrowUp' })
    fireEvent.keyDown(item('Panes'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Git'))
    fireEvent.keyDown(item('Git'), { key: 'End' })
    expect(document.activeElement).toBe(item('CLI'))
    expect(current()).toEqual(['CLI'])
  })

  // The sidebar's `!` is out of sight while Settings has the window; the row it points at carries it.
  it('flags CLI in the list when the command needs fixing', () => {
    seed({ cli: { ...linkedCli(), state: 'absent', resolved: null } })
    render(<SettingsView />)
    const cli = within(nav()).getByRole('button', { name: /^CLI/ })
    expect(within(cli).getByRole('img', { name: 'CLI: Put teamree on my PATH' })).toBeTruthy()
    expect(within(item('Git')).queryByRole('img')).toBeNull()
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
    renderAt('cli')
    expect(
      screen.getByText('/usr/local/bin/teamree → /Applications/teamree.app/Contents/Resources/cli/teamree')
    ).toBeTruthy()
    expect(within(cliSection()).queryByRole('button')).toBeNull()
    expect(within(cliSection()).queryByText(/leads to|on your PATH\./)).toBeNull()
  })

  it('says it is not installed, and offers Install', () => {
    seed({ cli: { ...linkedCli(), state: 'absent', resolved: null, needsAdministrator: false } })
    renderAt('cli')
    expect(screen.getByText('Not installed')).toBeTruthy()
    expect(within(cliSection()).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(installCli).toHaveBeenCalled()
  })

  // A path wraps at its slashes, and the words after it do not wrap mid-word.
  it('lets the path break after each slash', () => {
    seed({ cli: { ...linkedCli(), state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: false } })
    renderAt('cli')
    const line = screen.getByText(/another copy/)
    expect(line.querySelectorAll('wbr').length).toBe('/usr/local/bin/teamree/Volumes/old/teamree'.split('/').length - 1)
    expect(line.textContent).toBe('/usr/local/bin/teamree → /Volumes/old/teamree (another copy)')
  })

  it('says where a wrong link leads, and offers Repair', () => {
    seed({ cli: { ...linkedCli(), state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: true } })
    renderAt('cli')
    expect(screen.getByText('/usr/local/bin/teamree → /Volumes/old/teamree (missing)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }))
    expect(installCli).toHaveBeenCalled()
  })
})

describe('updates', () => {
  it('says this build has nothing to compare against, instead of offering a check', () => {
    seed({ update: { ...release(), current: '0.0.0-dev', checkable: false } })
    renderAt('updates')
    expect(screen.getByText('teamree 0.0.0-dev (not a release)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check for Updates' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Check Automatically' })).toBeNull()
  })

  it('checks on request, and says when the last one was', () => {
    seed({ update: { ...release(), checkedAt: Date.now() - 4 * 60_000 } })
    renderAt('updates')
    expect(screen.getByText('Checked 4m ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('says a failed check could not check, beside the last answer, and nothing raw', () => {
    seed({
      update: { ...release(), checkedAt: Date.now(), succeededAt: Date.now() - 4 * 60_000, problem: 'fetch failed' }
    })
    renderAt('updates')
    expect(screen.getByText('Couldn’t check · offline · Checked 4m ago')).toBeTruthy()
    expect(screen.queryByText('fetch failed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }))
    expect(checkForUpdates).toHaveBeenCalledWith({ inline: true })
  })

  it('will not offer a second check while one is in flight', () => {
    seed({ update: { ...release(), checking: true } })
    renderAt('updates')
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
  })

  it('turns the automatic check off through the store', () => {
    renderAt('updates')
    const check = screen.getByLabelText('Check Automatically')
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
      renderAt('updates')
      expect(screen.getByText('teamree 1.5.0 available')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      expect(fetchInstaller).toHaveBeenCalled()
    })

    it('shows progress, then opens the installer', () => {
      const downloading = { state: 'downloading' as const, version: '1.5.0', received: 30, total: 100 }
      seed({ update: { ...release(), available, download: downloading } })
      const { unmount } = renderAt('updates')
      expect(screen.getByRole('button', { name: 'Downloading 30%' }).hasAttribute('disabled')).toBe(true)
      unmount()

      const ready = { state: 'ready' as const, version: '1.5.0', path: '/Users/me/Downloads/teamree-1.5.0.dmg' }
      seed({ update: { ...release(), available, download: ready } })
      renderAt('updates')
      fireEvent.click(screen.getByRole('button', { name: 'Open Installer' }))
      expect(openInstaller).toHaveBeenCalled()
    })

    it('restarts into a copy fetched in the background', () => {
      seed({ update: { ...release(), available, install: { state: 'ready', version: '1.5.0' } } })
      renderAt('updates')
      expect(screen.getByText('teamree 1.5.0 is ready')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Restart to Update' }))
      expect(restartToUpdate).toHaveBeenCalled()
    })

    it('says in one line why a download failed', () => {
      const failed = { state: 'failed' as const, version: '1.5.0', problem: 'Checksum mismatch; the file was deleted.' }
      seed({ update: { ...release(), available, download: failed } })
      renderAt('updates')
      expect(screen.getByText('Checksum mismatch; the file was deleted.')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    })
  })

  it('shows why the last check answered nothing, rather than swallowing it', () => {
    seed({ update: { ...release(), problem: 'github.com could not be reached' } })
    renderAt('updates')
    expect(screen.getByText('Couldn’t check · github.com could not be reached')).toBeTruthy()
  })
})

describe('panes', () => {
  it('writes a new terminal text size through, under a label and no caption', () => {
    renderAt('panes')
    fireEvent.change(screen.getByLabelText('Terminal text size'), { target: { value: '17' } })
    expect(setTerminalFontSize).toHaveBeenCalledWith(17)
    // Every preference on this page is per-machine and none of them says so.
    expect(screen.queryByText(/Remembered on this machine only/)).toBeNull()
  })

  it('shows the size it is at, which a slider alone cannot say', () => {
    seed({ terminalFontSize: 15 })
    renderAt('panes')
    expect(screen.getByText('15px')).toBeTruthy()
  })

  it('previews a font as it is typed and keeps it once the field is left', () => {
    renderAt('panes')
    const field = screen.getByLabelText('Font') as HTMLInputElement
    expect(field.value).toBe(TERMINAL_OPTIONS_DEFAULT.fontFamily)

    fireEvent.change(field, { target: { value: 'Menlo' } })
    expect(screen.getByTestId('settings-font-preview').style.fontFamily).toBe('Menlo')
    expect(setTerminalOptions).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(setTerminalOptions).toHaveBeenCalledWith({ fontFamily: 'Menlo' })
  })

  it('sets the cursor shape and whether it blinks', () => {
    renderAt('panes')
    fireEvent.change(screen.getByLabelText('Cursor'), { target: { value: 'underline' } })
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorStyle: 'underline' })
    const blink = screen.getByLabelText('Blink') as HTMLInputElement
    expect(blink.checked).toBe(true)
    fireEvent.click(blink)
    expect(setTerminalOptions).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('turns Option as Meta and copy on select on', () => {
    renderAt('panes')
    fireEvent.click(screen.getByLabelText('Option as Meta'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ optionIsMeta: true })
    fireEvent.click(screen.getByLabelText('Copy on Select'))
    expect(setTerminalOptions).toHaveBeenCalledWith({ copyOnSelect: true })
  })

  it('takes a scrollback length on Enter, and leaves the bounds to the store', () => {
    seed({ terminalOptions: { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 10_000 } })
    renderAt('panes')
    const field = screen.getByLabelText('Scrollback lines') as HTMLInputElement
    expect(field.value).toBe('10000')
    fireEvent.change(field, { target: { value: '25000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setTerminalOptions).toHaveBeenCalledWith({ scrollback: 25_000 })
  })
})

describe('general', () => {
  it('keeps the Mac awake while agents work, always, or leaves it to the system', () => {
    render(<SettingsView />)
    const mode = screen.getByLabelText('Keep Awake') as HTMLSelectElement
    expect(mode.value).toBe('agent')
    expect([...mode.options].map((option) => option.text)).toEqual(['While Agents Work', 'Always', 'Off'])
    fireEvent.change(mode, { target: { value: 'on' } })
    expect(setKeepAwake).toHaveBeenCalledWith('on')
  })
})

/** Answers the page's runtime settings reads and writes, keeping what was sent; `refuse` fails the next write. */
function runtimeSettings(initial: Record<string, unknown> = {}): { sent: unknown[]; refuse: (reason: string) => void } {
  const sent: unknown[] = []
  let refusal: string | null = null
  let current = { ...DEFAULT_RUNTIME_SETTINGS, shellFallback: '/bin/zsh', ...initial }
  runtimeCall.answer = (method, params) => {
    if (method === 'settings.get') return Promise.resolve(current)
    if (method !== 'settings.set') return new Promise(() => {})
    sent.push(params)
    if (refusal !== null) {
      const reason = refusal
      refusal = null
      return Promise.reject(new Error(reason))
    }
    current = { ...current, ...(params as object) }
    return Promise.resolve(current)
  }
  return { sent, refuse: (reason) => (refusal = reason) }
}

describe('what this Mac does for every project', () => {
  afterEach(() => {
    runtimeCall.answer = () => new Promise(() => {})
  })

  it('opens every project in the default editor unless the project names its own', () => {
    seed({
      editors: [
        { command: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor' },
        { command: 'dev.zed.Zed', label: 'Zed', kind: 'editor' }
      ],
      editorCommands: { '*': 'dev.zed.Zed' }
    })
    render(<SettingsView />)
    const machine = screen.getByLabelText('Default editor') as HTMLSelectElement
    expect(machine.value).toBe('dev.zed.Zed')
    expect([...machine.options].map((option) => option.text)[0]).toBe('First found (VS Code)')
    fireEvent.change(machine, { target: { value: 'com.microsoft.VSCode' } })
    expect(setEditorCommand).toHaveBeenCalledWith('*', 'com.microsoft.VSCode')

    show('Projects')
    const project = screen.getByLabelText('Open checkouts in') as HTMLSelectElement
    expect(project.value).toBe('')
    expect(project.options[0]?.text).toBe('Default (Zed)')
  })

  it('asks before deleting a worktree until told not to', () => {
    render(<SettingsView />)
    const box = screen.getByRole('switch', { name: 'Ask Before Deleting Worktrees' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(setConfirmation).toHaveBeenCalledWith('removeWorktree', false)
  })

  it('fetches every project’s base as often as picked', async () => {
    const { sent } = runtimeSettings()
    renderAt('git')
    const every = screen.getByLabelText('Fetch every') as HTMLSelectElement
    await vi.waitFor(() => expect(every.value).toBe('5'))
    expect([...every.options].map((option) => option.text)).toEqual([
      '1 minute',
      '5 minutes',
      '15 minutes',
      '30 minutes',
      '1 hour'
    ])
    fireEvent.change(every, { target: { value: '15' } })
    await vi.waitFor(() => expect(sent).toEqual([{ fetchMinutes: 15 }]))
  })
})

describe('the shell and line height of new panes', () => {
  afterEach(() => {
    runtimeCall.answer = () => new Promise(() => {})
  })

  it('starts new panes in the shell named, showing the login shell while none is', async () => {
    const { sent, refuse } = runtimeSettings()
    renderAt('panes')
    const field = screen.getByLabelText('Shell') as HTMLInputElement
    await vi.waitFor(() => expect(field.placeholder).toBe('/bin/zsh'))

    refuse('fish is not a full path')
    fireEvent.change(field, { target: { value: 'fish' } })
    fireEvent.blur(field)
    expect(await screen.findByText('fish is not a full path')).toBeTruthy()

    fireEvent.change(field, { target: { value: '/bin/bash' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await vi.waitFor(() => expect(sent).toEqual([{ shell: 'fish' }, { shell: '/bin/bash' }]))
    await vi.waitFor(() => expect(screen.queryByText('fish is not a full path')).toBeNull())
  })

  it('takes a line height on Enter, and leaves the bounds to the store', () => {
    renderAt('panes')
    const field = screen.getByLabelText('Line height') as HTMLInputElement
    expect(field.value).toBe('1.25')
    fireEvent.change(field, { target: { value: '1.4' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setTerminalOptions).toHaveBeenCalledWith({ lineHeight: 1.4 })
  })

  it('asks before stopping a working agent until told not to', () => {
    renderAt('panes')
    const box = screen.getByRole('switch', { name: 'Ask Before Stopping Agents' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(setConfirmation).toHaveBeenCalledWith('stopAgent', false)
  })
})

describe('Keep Agents Running', () => {
  afterEach(() => {
    runtimeCall.answer = () => new Promise(() => {})
  })

  it('says which open panes still end with the app, moves idle shells, and stops the host', async () => {
    const asked: string[] = []
    let status = { running: true, pid: 4540, panes: 1, inProcess: 3, shells: 2 }
    runtimeCall.answer = (method) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS, keepPanesRunning: true })
      if (method === 'paneHost.status') return Promise.resolve(status)
      if (method === 'paneHost.keepShells') {
        asked.push(method)
        status = { ...status, panes: 3, inProcess: 1, shells: 0 }
        return Promise.resolve({ moved: ['t1', 't2'] })
      }
      if (method === 'paneHost.stop') {
        asked.push(method)
        status = { running: false, panes: 0, inProcess: 1, shells: 0 } as typeof status
        return Promise.resolve({ stopped: true, pid: 4540, panes: 3 })
      }
      return new Promise(() => {})
    }
    renderAt('panes')
    expect(await screen.findByText('3 open panes end when teamree quits; new panes keep running')).toBeTruthy()
    expect(screen.getByText('Host running · 1 pane')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep 2 Shells Running' }))
    expect(await screen.findByText('Host running · 3 panes')).toBeTruthy()
    expect(screen.getByText('1 open pane ends when teamree quits; new panes keep running')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Shells? Running/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Stop Host' }))
    await vi.waitFor(() => expect(screen.queryByText(/Host running/)).toBeNull())
    expect(asked).toEqual(['paneHost.keepShells', 'paneHost.stop'])
  })

  it('says nothing under the switch while it is off and no host runs', async () => {
    let read = false
    runtimeCall.answer = (method) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS })
      if (method === 'paneHost.status') {
        read = true
        return Promise.resolve({ running: false, panes: 0, inProcess: 3, shells: 0 })
      }
      return new Promise(() => {})
    }
    renderAt('panes')
    await vi.waitFor(() => expect(read).toBe(true))
    expect(screen.queryByText(/open panes? end/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop Host' })).toBeNull()
  })
})

describe('notifications', () => {
  it('sets how, and which events notify', () => {
    renderAt('notices')
    const how = screen.getByLabelText('Notify') as HTMLSelectElement
    expect([...how.options].map((option) => option.text)).toEqual(['Never', 'Silently', 'With Sound'])
    fireEvent.change(how, { target: { value: 'sound' } })
    expect(setAgentNotices).toHaveBeenCalledWith('sound')

    for (const [label, event] of [
      ['Agent Finishes', 'finished'],
      ['Agent Asks', 'asking'],
      ['Teammate Shares a Note', 'teammates']
    ] as const) {
      const box = screen.getByRole('switch', { name: label }) as HTMLInputElement
      expect(box.checked).toBe(true)
      fireEvent.click(box)
      expect(setNoticeEvent).toHaveBeenCalledWith(event, false)
    }
  })

  it('leaves the events alone while nothing notifies', () => {
    seed({ agentNotices: 'off' })
    renderAt('notices')
    expect((screen.getByRole('switch', { name: 'Agent Asks' }) as HTMLInputElement).disabled).toBe(true)
  })
})

describe('git', () => {
  it('sets how diffs open: layout, wrapping and whitespace', () => {
    seed({ diffLayout: 'inline', diffOptions: { wrap: false, hideWhitespace: true } })
    renderAt('git')
    fireEvent.change(screen.getByLabelText('Diff layout'), { target: { value: 'split' } })
    expect(setDiffLayout).toHaveBeenCalledWith('split')

    const wrap = screen.getByLabelText('Wrap Diff Lines') as HTMLInputElement
    expect(wrap.checked).toBe(false)
    fireEvent.click(wrap)
    expect(toggleDiffOption).toHaveBeenCalledWith('wrap')

    const whitespace = screen.getByLabelText('Hide Whitespace Changes') as HTMLInputElement
    expect(whitespace.checked).toBe(true)
    fireEvent.click(whitespace)
    expect(toggleDiffOption).toHaveBeenCalledWith('hideWhitespace')
  })
})

describe('shortcuts', () => {
  const section = (): HTMLElement => screen.getByRole('region', { name: 'Shortcuts' })
  const commands = (): string[] =>
    within(section())
      .getAllByRole('listitem')
      .map((row) => row.firstElementChild?.textContent ?? '')

  it('lists every command with its chord, read only', () => {
    renderAt('shortcuts', { modifier: MAC })
    const row = within(section()).getByText('Split Pane Right').closest('li') as HTMLElement
    expect(within(row).getByText('⌘D')).toBeTruthy()
    expect(within(section()).queryByRole('textbox')).toBeNull()
    expect(within(section()).queryByRole('button')).toBeNull()
  })

  it('filters to the commands named, and shows them all for what the section is about', () => {
    renderAt('shortcuts', { modifier: MAC })
    const filter = screen.getByRole('searchbox', { name: 'Filter settings' })
    fireEvent.change(filter, { target: { value: 'split pane' } })
    expect(commands()).toEqual(['Split Pane Right', 'Split Pane Down'])

    fireEvent.change(filter, { target: { value: 'keybindings' } })
    expect(commands()).toContain('New Terminal')
  })
})

describe('appearance', () => {
  // The controls live in the sheet beside the panes; a page that hides them is no place to judge a theme.
  it('names the theme in effect, and opens the sheet to change it', () => {
    seed({ appearance: { ...INITIAL.appearance, mode: 'dark' }, systemTone: 'dark' })
    renderAt('appearance')
    const section = screen.getByRole('region', { name: 'Appearance' })
    expect(within(section).queryByRole('radiogroup')).toBeNull()
    expect(within(section).getByText('Charcoal · Dark')).toBeTruthy()
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
    expect(filter().placeholder).toBe('Search')
  })

  it('finds a row by what it is about, marks its label, and shows every section holding one', () => {
    render(<SettingsView />)
    type('location')
    expect(nav()).toEqual(['General', 'Projects'])
    expect(screen.getAllByRole('region')).toHaveLength(2)
    const general = document.getElementById('settings-general')?.closest('section') as HTMLElement
    expect(within(general).getByText('Worktrees in').tagName).toBe('MARK')
    expect(within(general).queryByText('Branch prefix')).toBeNull()
  })

  it('opens filtered to the setting the palette named', () => {
    render(<SettingsView />)
    act(() => useWorkspaceStore.getState().openSetting('Scrollback lines'))
    expect(filter().value).toBe('Scrollback lines')
    expect(nav()).toEqual(['Panes'])
    expect(useWorkspaceStore.getState().settingsQuery).toBeNull()
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
    expect(screen.getByLabelText('Notify').hasAttribute('data-match')).toBe(true)

    type('cursor')
    expect(nav()).toEqual(['General', 'Projects', 'Panes'])
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
    expect(label.querySelector('mark')?.textContent).toBe('on Sel')
    expect(label.textContent).toBe('Copy on Select')
  })

  it('keeps a whole section whose title matches', () => {
    render(<SettingsView />)
    type('updates')
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Check Automatically' })).toBeTruthy()
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
    expect(nav()).toEqual([
      'General',
      'Projects',
      'Git',
      'Panes',
      'Notifications',
      'Teamwork',
      'Appearance',
      'Shortcuts',
      'Add-ons',
      'Updates',
      'CLI'
    ])
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
  const atlas: Project = { id: 'p2', name: 'atlas', path: '/repos/atlas', baseRef: 'origin/main' }

  it('shows one project at a time, picked above its settings', () => {
    seed({ projects: [project, atlas], relays: {} })
    renderAt('projects')
    const picker = screen.getByRole('group', { name: 'Project' })
    expect(within(picker).getByRole('button', { name: 'pager' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('heading', { name: 'pager' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'atlas' })).toBeNull()

    fireEvent.click(within(picker).getByRole('button', { name: 'atlas' }))
    expect(screen.getByRole('heading', { name: 'atlas' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'pager' })).toBeNull()
  })

  it('offers no picker for one project, and none under a filter, which shows every project it matched', () => {
    renderAt('projects')
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull()
    cleanup()

    seed({ projects: [project, atlas], relays: {} })
    renderAt('projects')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter settings' }), { target: { value: 'symlink' } })
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'pager' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'atlas' })).toBeTruthy()
  })

  it('keeps a long path on one line, cut in the middle so its folder shows, whole on hover', () => {
    seed({ projects: [{ ...project, path: '/Users/sam/code/clients/acme/pager' }] })
    renderAt('projects')
    const path = screen.getByTitle('/Users/sam/code/clients/acme/pager')
    expect(path.querySelector('.settings-path__tail')?.textContent).toBe('acme/pager')
    expect(path.textContent).toBe('/Users/sam/code/clients/acme/pager')
    expect(path.querySelector('wbr')).toBeNull()
  })

  it('says so in a sentence when there are none, rather than showing an empty list', () => {
    seed({ projects: [], relays: {} })
    renderAt('projects')
    expect(screen.getByText(/No repositories yet/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Relay' })).toBeNull()
  })

  it('reveals the repository at its own path, named so the notice can say what failed', () => {
    renderAt('projects')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(revealInFinder).toHaveBeenCalledWith('/repos/pager', 'the pager repository')
  })

  // An example in the field reads as a value: a fresh project would look set to run `npm ci`.
  it('shows None in an empty list or command field, with the examples in its tooltip', () => {
    seed({ agents: [claude] })
    renderAt('projects')
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

  it('names the command the lockfile suggests beside None, without filling it in', () => {
    seed({ projects: [{ ...project, suggestedSetup: 'pnpm install --frozen-lockfile' }] })
    renderAt('projects')
    const field = screen.getByLabelText('Setup command') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('None · pnpm install --frozen-lockfile detected')
  })
})

describe('fetching in the background', () => {
  it('is on for a project that never said otherwise, and turns off for that project alone', () => {
    renderAt('projects')
    const box = screen.getByLabelText('Fetch in Background') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { fetchInBackground: false })
  })

  it('reads off, and turns back on, for a project that turned it off', () => {
    seed({ projects: [{ ...project, fetchInBackground: false }] })
    renderAt('projects')
    const box = screen.getByLabelText('Fetch in Background') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { fetchInBackground: true })
  })
})

describe('what a new worktree carries over from the primary checkout', () => {
  it('writes one list per line, dropping blanks, when the field is left', () => {
    renderAt('projects')
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.change(field, { target: { value: 'node_modules\n\n  .venv  \n' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: ['node_modules', '.venv'] })
  })

  it('keeps the two lists apart', () => {
    seed({ projects: [{ ...project, linkedPaths: ['node_modules'], copiedPaths: ['.env'] }] })
    renderAt('projects')
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
    renderAt('projects')
    const field = screen.getByLabelText('Symlink into every new worktree')
    fireEvent.blur(field)
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { linkedPaths: [] })
  })

  it('saves the setup command through the same method, trimmed, when the field is left', () => {
    renderAt('projects')
    const field = screen.getByLabelText('Setup command')
    fireEvent.change(field, { target: { value: '  npm ci  ' } })
    expect(setProjectPaths).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: 'npm ci' })
  })

  it('shows the stored command, and writes an empty one when it is emptied', () => {
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    renderAt('projects')
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
    renderAt('projects')
    const row = screen.getByText('Start new worktrees from').closest('.settings-field') as HTMLElement
    expect(within(row).getByText('origin/main')).toBeTruthy()
    expect(within(row).queryByRole('textbox')).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Use origin/main' })).toBeNull()
  })

  it('commits what was typed when the field is left', () => {
    renderAt('projects')
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
    renderAt('projects')
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: 'release/2026' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', 'release/2026')
  })

  it('puts the field away on Escape and keeps nothing', () => {
    renderAt('projects')
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
    renderAt('projects')
    expect(screen.getByText('develop')).toBeTruthy()
    // Null, not '': `withStartPoint` removes the entry for null.
    fireEvent.click(screen.getByRole('button', { name: 'Use origin/main' }))
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  it('passes null when the field is emptied and left, the same as the button', () => {
    seed({ startPointDefaults: { p1: 'develop' } })
    renderAt('projects')
    change()
    const field = screen.getByLabelText('Start new worktrees from')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setStartPointDefault).toHaveBeenCalledWith('p1', null)
  })

  // The buttons name the ref they would use; no paragraph under them.
  it('captions the start point with nothing at all', () => {
    renderAt('projects')
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
    renderAt('projects')

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
    renderAt('projects')

    expect(picker().value).toBe('dev.zed.Zed')
    fireEvent.change(picker(), { target: { value: '' } })
    expect(setEditorCommand).toHaveBeenCalledWith('p1', null)
  })

  it('takes any program by name under Other', () => {
    seed({ editors: INSTALLED })
    renderAt('projects')

    expect(screen.queryByLabelText('Editor command')).toBeNull()
    fireEvent.change(picker(), { target: { value: 'other' } })
    const field = screen.getByLabelText('Editor command')
    fireEvent.change(field, { target: { value: ' mate ' } })
    fireEvent.blur(field)
    expect(setEditorCommand).toHaveBeenCalledWith('p1', 'mate')
  })

  it('shows a program this project names in the field', () => {
    seed({ editors: INSTALLED, editorCommands: { p1: 'mate' } })
    renderAt('projects')

    expect(picker().value).toBe('other')
    expect((screen.getByLabelText('Editor command') as HTMLInputElement).value).toBe('mate')
  })

  it('says nothing about PATH', () => {
    seed({ editors: [] })
    renderAt('projects')

    expect([...picker().options].map((option) => option.text)).toEqual(['First found', 'Other…'])
    expect(screen.queryByText(/PATH/)).toBeNull()
  })
})

describe('the relay a project meets on', () => {
  it('reads it, and names where the URL in effect came from', () => {
    renderAt('projects')
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
    renderAt('projects')
    const block = within(relayBlock())
    expect(
      block.getByText(/TEAMREE_RELAY_URL=wss:\/\/tunnel\.example\/v1\/relay overrides \.teamree\/relay/)
    ).toBeTruthy()
  })

  it('offers no field to edit the relay, and sends the reader where one is set', () => {
    renderAt('projects')
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
    renderAt('projects')
    const block = within(relayBlock())
    expect(block.getByText('None').className).toBe('settings-fact settings-fact--none')
    expect(block.queryByText(/No \.teamree\/relay/)).toBeNull()
  })
})

// The two per-machine agent preferences, and the command line composed by the runtime's own function.
describe('the agent you always use', () => {
  it('offers the installed agents, and first-found as the way to mean no preference', () => {
    seed({ agents: [claude, codex] })
    renderAt('agents')

    const select = screen.getByLabelText('Default agent') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'claude', 'codex'])
    expect([...select.options].map((option) => option.textContent)).toEqual(['First found', 'Claude Code', 'Codex'])

    fireEvent.change(select, { target: { value: 'codex' } })
    expect(setDefaultAgent).toHaveBeenCalledWith('codex')
  })

  it('trusts new worktrees unless unticked, with nothing but the label', () => {
    seed({ agents: [claude, codex] })
    renderAt('agents')

    expect(loadAgentTrust).toHaveBeenCalled()
    const check = screen.getByRole('switch', { name: 'Trust New Worktrees' }) as HTMLInputElement
    expect(check.checked).toBe(true)
    fireEvent.click(check)
    expect(setTrustNewWorktrees).toHaveBeenCalledWith(false)
    expect(check.closest('.settings-field')?.textContent).toBe('Trust New Worktrees')
  })

  it('keeps agents running on quit only once ticked, through the runtime', async () => {
    const sent: unknown[] = []
    runtimeCall.answer = (method, params) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS })
      if (method !== 'settings.set') return new Promise(() => {})
      sent.push(params)
      return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS, keepPanesRunning: true })
    }
    try {
      seed({ agents: [claude, codex] })
      renderAt('panes')
      const name = 'Keep Agents Running When teamree Quits'
      const box = (await screen.findByRole('switch', { name })) as HTMLInputElement
      await vi.waitFor(() => expect(box.disabled).toBe(false))
      expect(box.checked).toBe(false)
      expect(box.closest('.settings-field')?.textContent).toBe(name)
      fireEvent.click(box)
      await vi.waitFor(() => expect(box.checked).toBe(true))
      expect(sent).toEqual([{ keepPanesRunning: true }])

      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'survive' } })
      expect(screen.getByRole('switch', { name })).toBeTruthy()
      expect(screen.queryByLabelText('Scrollback lines')).toBeNull()
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('warns agents about overlaps unless unticked, through the runtime', async () => {
    const sent: unknown[] = []
    runtimeCall.answer = (method, params) => {
      if (method === 'settings.get') return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS })
      if (method !== 'settings.set') return new Promise(() => {})
      sent.push(params)
      return Promise.resolve({ ...DEFAULT_RUNTIME_SETTINGS, warnAgentsAboutOverlaps: false })
    }
    try {
      seed({ agents: [claude, codex] })
      renderAt('agents')
      const box = (await screen.findByRole('switch', { name: 'Warn Agents About Overlaps' })) as HTMLInputElement
      await vi.waitFor(() => expect(box.disabled).toBe(false))
      expect(box.checked).toBe(true)
      expect(box.closest('.settings-field')?.textContent).toBe('Warn Agents About Overlaps')
      fireEvent.click(box)
      await vi.waitFor(() => expect(box.checked).toBe(false))
      expect(sent).toEqual([{ warnAgentsAboutOverlaps: false }])

      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overlap' } })
      expect(screen.getByRole('switch', { name: 'Warn Agents About Overlaps' })).toBeTruthy()
      expect(screen.queryByRole('switch', { name: 'Trust New Worktrees' })).toBeNull()
    } finally {
      runtimeCall.answer = () => new Promise(() => {})
    }
  })

  it('keeps the trust row under a filter for it', () => {
    seed({ agents: [claude, codex], trustNewWorktrees: false })
    renderAt('agents')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'trust' } })
    expect((screen.getByRole('switch', { name: 'Trust New Worktrees' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('Default agent')).toBeNull()
  })

  it('shows the full command under an agent given arguments, verbatim', () => {
    seed({ agents: [claude, codex], agentArgs: { claude: '--model opus' } })
    renderAt('agents')

    const section = screen.getByRole('heading', { name: 'Agents' }).parentElement as HTMLElement
    expect([...section.querySelectorAll('code')].map((node) => node.textContent)).toEqual(['claude --model opus'])
  })

  // `None` read as "no command" beside the command New task runs.
  it('shows the command an untouched agent runs in its empty field, and nothing under it', () => {
    seed({ agents: [claude, { ...codex, command: 'codex-cli' }] })
    renderAt('agents')
    expect((screen.getByLabelText('Claude Code') as HTMLInputElement).placeholder).toBe('claude')
    expect((screen.getByLabelText('Codex') as HTMLInputElement).placeholder).toBe('codex-cli')
    expect(screen.queryByText('None')).toBeNull()
    const section = screen.getByRole('heading', { name: 'Agents' }).parentElement as HTMLElement
    expect(section.querySelectorAll('code')).toHaveLength(0)
  })

  it('says Not found under an agent it has arguments for that is no longer on PATH', () => {
    seed({ agents: [claude], agentsProbed: true, agentArgs: { codex: '--full-auto' } })
    const view = renderAt('agents')
    const field = screen.getByLabelText('Codex') as HTMLInputElement
    expect(field.value).toBe('--full-auto')
    const caption = screen.getByText('Not found')
    expect(caption.className).toContain('settings-launch--missing')
    expect(screen.queryByText('codex --full-auto')).toBeNull()

    // Before the probe answers, nothing is known to be missing.
    view.unmount()
    seed({ agents: [claude], agentsProbed: false, agentArgs: { codex: '--full-auto' } })
    renderAt('agents')
    expect(screen.queryByLabelText('Codex')).toBeNull()
  })

  // The names New task uses, with the mark; the field says what it takes.
  it('names each agent the way New task does, beside a field for extra arguments', () => {
    seed({ agents: [claude, codex] })
    renderAt('agents')
    for (const name of ['Claude Code', 'Codex']) {
      const field = screen.getByLabelText(name) as HTMLInputElement
      expect(field.title).toBe('Extra arguments')
      const label = document.querySelector(`label[for="${field.id}"]`)
      expect(label?.querySelector('.agent-glyph')).not.toBeNull()
    }
  })

  it('shows the command changing as it is typed, before anything is committed', () => {
    seed({ agents: [claude] })
    renderAt('agents')

    fireEvent.change(screen.getByLabelText('Claude Code'), { target: { value: '--permission-mode plan' } })
    expect(screen.getByText('claude --permission-mode plan')).toBeTruthy()
    expect(setAgentArgs).not.toHaveBeenCalled()

    fireEvent.blur(screen.getByLabelText('Claude Code'))
    expect(setAgentArgs).toHaveBeenCalledWith('claude', '--permission-mode plan')
  })

  // Null, as with the start point above.
  it('clears an agent’s arguments rather than storing an empty string', () => {
    seed({ agents: [claude], agentArgs: { claude: '--model opus' } })
    renderAt('agents')

    const field = screen.getByLabelText('Claude Code')
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.blur(field)
    expect(setAgentArgs).toHaveBeenCalledWith('claude', null)
  })

  it('gives its select the same style as every other select in the app', () => {
    seed({ agents: [claude] })
    renderAt('agents')
    let seen = 0
    for (const label of ['Agents', 'General', 'Git']) {
      show(label)
      for (const select of document.querySelectorAll('select')) {
        expect(select.className).toBe('select__input')
        expect(select.parentElement?.className).toBe('select')
        expect(select.parentElement?.querySelector('.select__chevron svg')).not.toBeNull()
        seen += 1
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4)
  })

  // Every control in the section is about an agent this machine has.
  it('is not on the page at all when the machine has no agent', () => {
    seed({ agents: [] })
    renderAt('agents')
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull()
  })
})

describe('setup shared through .teamree/project.json', () => {
  /** The source line under a field: its chip and, for an override, Reset. */
  const sourceOf = (label: string): HTMLElement =>
    screen.getByLabelText(label).closest('.settings-field')?.querySelector('.settings-source') as HTMLElement

  it('shows the repository’s value with a Repository chip and nothing to reset', () => {
    seed({ projects: [{ ...project, repository: { setupCommand: 'npm ci', copiedPaths: ['.env'] } }] })
    renderAt('projects')
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('npm ci')
    expect((screen.getByLabelText('Copy into every new worktree') as HTMLTextAreaElement).value).toBe('.env')
    expect(within(sourceOf('Setup command')).getByText('Repository')).toBeTruthy()
    expect(within(sourceOf('Setup command')).queryByRole('button', { name: 'Reset' })).toBeNull()
  })

  it('marks a value set here as This Mac, and Reset hands it back to the repository', () => {
    seed({ projects: [{ ...project, setupCommand: 'pnpm i', repository: { setupCommand: 'npm ci' } }] })
    renderAt('projects')
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm i')
    const source = within(sourceOf('Setup command'))
    expect(source.getByText('This Mac')).toBeTruthy()
    fireEvent.click(source.getByRole('button', { name: 'Reset' }))
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: '' })
  })

  it('shows the repository’s command again when the field is emptied', () => {
    seed({ projects: [{ ...project, setupCommand: 'pnpm i', repository: { setupCommand: 'npm ci' } }] })
    renderAt('projects')
    const field = screen.getByLabelText('Setup command') as HTMLInputElement
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(setProjectPaths).toHaveBeenCalledWith('p1', { setupCommand: '' })
    expect(field.value).toBe('npm ci')
  })

  it('says nothing about a source for a value the repository does not carry', () => {
    seed({ projects: [{ ...project, setupCommand: 'npm ci' }] })
    renderAt('projects')
    expect(sourceOf('Setup command')).toBeNull()
  })

  it('writes the file with Save to Repository, a secondary button', () => {
    renderAt('projects')
    const save = screen.getByRole('button', { name: 'Save to Repository' })
    expect(save.className).not.toContain('button--primary')
    fireEvent.click(save)
    expect(saveProjectSettings).toHaveBeenCalledWith('p1')
  })

  it('says in one line when the file cannot be read', () => {
    seed({ projects: [{ ...project, repositoryProblem: 'project.json unreadable' }] })
    renderAt('projects')
    expect(screen.getByText('project.json unreadable')).toBeTruthy()
  })

  it('starts worktrees from the repository’s ref when this Mac has not chosen one', () => {
    seed({ projects: [{ ...project, repository: { startFrom: 'origin/dev' } }] })
    renderAt('projects')
    expect(screen.getByText('origin/dev')).toBeTruthy()
  })
})

describe('general', () => {
  const bridge = (platform: string) => {
    ;(window as unknown as { teamree: unknown }).teamree = { platform }
    let settings = { ...DEFAULT_RUNTIME_SETTINGS }
    return vi.spyOn(runtimeClient, 'call').mockImplementation(async (method: string, params: unknown) => {
      if (method === 'settings.set') settings = { ...settings, ...(params as object) }
      return method.startsWith('settings.') ? settings : new Promise(() => {})
    })
  }

  it('offers Show in Menu Bar on a Mac, on by default, and sets it from the checkbox', async () => {
    const call = bridge('darwin')
    try {
      render(<SettingsView />)
      const check = await screen.findByRole('switch', { name: 'Show in Menu Bar' })
      await vi.waitFor(() => expect(check).toHaveProperty('checked', true))
      fireEvent.click(check)
      expect(call).toHaveBeenCalledWith('settings.set', { showInMenuBar: false })
      await vi.waitFor(() => expect(check).toHaveProperty('checked', false))
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })

  it('leaves Show in Menu Bar out where there is no menu bar to show in', async () => {
    const call = bridge('linux')
    try {
      render(<SettingsView />)
      await screen.findByRole('switch', { name: 'Show Cost' })
      expect(screen.queryByRole('switch', { name: 'Show in Menu Bar' })).toBeNull()
      expect(document.getElementById('settings-general')).not.toBeNull()
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })

  it('offers Show Cost, off by default, and tells the token surfaces at once', async () => {
    const call = bridge('darwin')
    try {
      render(<SettingsView />)
      const check = await screen.findByRole('switch', { name: 'Show Cost' })
      await vi.waitFor(() => expect(check).toHaveProperty('disabled', false))
      expect(check).toHaveProperty('checked', false)
      fireEvent.click(check)
      expect(call).toHaveBeenCalledWith('settings.set', { showCost: true })
      expect(useUsageStore.getState().showCost).toBe(true)
      await vi.waitFor(() => expect(check).toHaveProperty('checked', true))
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })

  const folderBridge = (answer: (method: string, params: Record<string, unknown>) => unknown) => {
    ;(window as unknown as { teamree: unknown }).teamree = {
      platform: 'darwin',
      homeDir: '/Users/sam',
      chooseFolder: async () => '/Volumes/work/wt'
    }
    let settings: Record<string, unknown> = {
      ...DEFAULT_RUNTIME_SETTINGS,
      worktreesRootFallback: '/Users/sam/.teamree/worktrees'
    }
    return vi.spyOn(runtimeClient, 'call').mockImplementation(async (method: string, params: unknown) => {
      const given = (params ?? {}) as Record<string, unknown>
      const own = answer(method, given)
      if (own !== undefined) return own
      if (method === 'settings.set') settings = { ...settings, ...given }
      return method.startsWith('settings.') ? settings : new Promise(() => {})
    })
  }

  it('shows where worktrees go, and sets this Mac’s folder from Choose…', async () => {
    const call = folderBridge(() => undefined)
    try {
      render(<SettingsView />)
      const general = document.getElementById('settings-general')?.closest('section') as HTMLElement
      await within(general).findByTitle('/Users/sam/.teamree/worktrees')
      fireEvent.click(within(general).getByRole('button', { name: 'Choose…' }))
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith('settings.set', { worktreesRoot: '/Volumes/work/wt' }))
      await within(general).findByTitle('/Volumes/work/wt')
      expect(within(general).getByRole('button', { name: 'Reset' })).toBeTruthy()
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })

  it('says why a folder inside a repository was refused, and takes it with Use Anyway', async () => {
    const refused = Object.assign(new Error('/Volumes/work/wt is inside pager'), {
      data: { refusal: 'insideRepository' }
    })
    const call = folderBridge((method, params) =>
      method === 'settings.set' && params.allowInsideRepository !== true ? Promise.reject(refused) : undefined
    )
    try {
      render(<SettingsView />)
      const general = document.getElementById('settings-general')?.closest('section') as HTMLElement
      await within(general).findByTitle('/Users/sam/.teamree/worktrees')
      fireEvent.click(within(general).getByRole('button', { name: 'Choose…' }))
      await within(general).findByText('/Volumes/work/wt is inside pager')
      fireEvent.click(within(general).getByRole('button', { name: 'Use Anyway' }))
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith('settings.set', {
          worktreesRoot: '/Volumes/work/wt',
          allowInsideRepository: true
        })
      )
      await within(general).findByTitle('/Volumes/work/wt')
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })

  it('keeps a branch prefix for this Mac, and one per project over it', async () => {
    seed({ projects: [project] })
    const call = folderBridge((method, params) =>
      method === 'project.setPaths' ? { ...project, branchPrefix: params.branchPrefix } : undefined
    )
    try {
      render(<SettingsView />)
      const mac = document.getElementById('settings-branch-prefix') as HTMLInputElement
      fireEvent.change(mac, { target: { value: 'abd/' } })
      fireEvent.blur(mac)
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith('settings.set', { branchPrefix: 'abd/' }))

      show('Projects')
      const own = document.getElementById('settings-branch-prefix-p1') as HTMLInputElement
      await vi.waitFor(() => expect(own.placeholder).toBe('abd/'))
      fireEvent.change(own, { target: { value: 'team/' } })
      fireEvent.keyDown(own, { key: 'Enter' })
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith('project.setPaths', { projectId: 'p1', branchPrefix: 'team/' })
      )
      await vi.waitFor(() => expect(own.value).toBe('team/'))
    } finally {
      call.mockRestore()
      delete (window as unknown as { teamree?: unknown }).teamree
    }
  })
})
