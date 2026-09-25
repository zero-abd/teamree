/** @vitest-environment jsdom */

// The card: release notes rendered safely, and quiet — absent when there is
// nothing to say, out of the way of modals, gone until a newer release after Later.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatus, UpdateState } from '@shared/entities'

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
const { UpdateAvailableCard } = await import('./UpdateAvailableCard')
const { INSTALL_DOCUMENT } = await import('./updateNotice')
const { APP_MANAGEMENT_SETTINGS } = await import('@shared/entities')

const INITIAL = useWorkspaceStore.getState()

const downloadUpdate = vi.fn()
const fetchInstaller = vi.fn()
const openInstaller = vi.fn()
const restartToUpdate = vi.fn()
const setAutomaticUpdates = vi.fn()

function update(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    current: '0.1.0',
    checkable: true,
    automatic: true,
    available: {
      version: '0.2.0',
      tag: 'v0.2.0',
      notes: 'Panes resize faster.',
      downloadUrl: 'https://github.com/zero-abd/teamree/releases/download/v0.2.0/teamree-mac-universal.dmg',
      releaseUrl: 'https://github.com/zero-abd/teamree/releases/tag/v0.2.0',
      publishedAt: 0
    },
    checking: false,
    checkedAt: 1_700_000_000_000,
    problem: null,
    ...overrides
  }
}

/** A CLI status with nothing to offer, so the first-run card is not in the way. */
function settledCli(): CliStatus {
  return {
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    packaged: true,
    bundle: '/Applications/teamree.app/Contents/Resources/cli/teamree.mjs',
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'linked',
    resolved: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    dangling: false,
    needsAdministrator: false,
    onPath: 'login',
    askedAt: 1,
    readAt: 1
  }
}

beforeEach(() => {
  downloadUpdate.mockClear()
  fetchInstaller.mockClear()
  openInstaller.mockClear()
  restartToUpdate.mockClear()
  setAutomaticUpdates.mockClear()
  localStorage.clear()
  useWorkspaceStore.setState({
    ...INITIAL,
    cli: settledCli(),
    dialog: null,
    update: update(),
    downloadUpdate,
    fetchInstaller,
    openInstaller,
    restartToUpdate,
    setAutomaticUpdates
  })
})

describe('the update card', () => {
  it('names the release and offers the download', () => {
    render(<UpdateAvailableCard />)

    expect(screen.getByText(/teamree 0\.2\.0 is available/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Download 0\.2\.0/ }))
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  // Announced once as it appears, not left for VoiceOver to stumble on.
  it('is a status a screen reader reads as it arrives', () => {
    render(<UpdateAvailableCard />)
    expect(screen.getByRole('status', { name: 'A newer version of teamree is available' })).toBeTruthy()
  })

  it('downloads a verifiable installer itself, shows progress, then opens it', () => {
    const available = { ...update().available!, installer: { name: 'teamree-0.2.0.dmg', size: 100 } }
    useWorkspaceStore.setState({ update: update({ available }) })
    const { rerender } = render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(fetchInstaller).toHaveBeenCalledTimes(1)
    expect(downloadUpdate).not.toHaveBeenCalled()

    useWorkspaceStore.setState({
      update: update({ available, download: { state: 'downloading', version: '0.2.0', received: 55, total: 100 } })
    })
    rerender(<UpdateAvailableCard />)
    expect(screen.getByRole('button', { name: 'Downloading 55%' }).hasAttribute('disabled')).toBe(true)

    useWorkspaceStore.setState({
      update: update({ available, download: { state: 'ready', version: '0.2.0', path: '/Users/me/Downloads/x.dmg' } })
    })
    rerender(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Installer' }))
    expect(openInstaller).toHaveBeenCalledTimes(1)
  })

  it('says in one line when the checksum did not match', () => {
    const available = { ...update().available!, installer: { name: 'teamree-0.2.0.dmg', size: 100 } }
    const download = { state: 'failed' as const, version: '0.2.0', problem: 'Checksum mismatch; the file was deleted.' }
    useWorkspaceStore.setState({ update: update({ available, download }) })
    render(<UpdateAvailableCard />)
    expect(screen.getByText('Checksum mismatch; the file was deleted.')).toBeTruthy()
  })

  // A release body is text from the internet: formatted, but never markup of its own.
  it('renders release notes as markdown, and a body full of markup stays text', () => {
    const notes = [
      '### What changed',
      '- **Faster** panes',
      '',
      '<img src=x onerror="globalThis.owned = true"><script>globalThis.owned = true</script>',
      '',
      '[run](javascript:globalThis.owned=true) ![pixel](https://example.com/p.png)'
    ].join('\n')
    useWorkspaceStore.setState({ update: update({ available: { ...update().available!, notes } }) })

    const { container } = render(<UpdateAvailableCard />)
    const body = container.querySelector('.update-card__notes') as HTMLElement

    expect(body.querySelector('h3')?.textContent).toBe('What changed')
    expect(body.querySelector('li strong')?.textContent).toBe('Faster')
    expect(body.textContent).toContain('<script>globalThis.owned = true</script>')
    expect(body.querySelector('img, script, [onerror]')).toBeNull()
    expect(body.querySelector('a[href^="javascript"]')).toBeNull()
    expect((globalThis as Record<string, unknown>).owned).toBeUndefined()
  })

  it('opens a link in the notes in the browser', () => {
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    const notes = 'See [the diff](https://github.com/zero-abd/teamree/compare/v0.1.0...v0.2.0).'
    useWorkspaceStore.setState({ update: update({ available: { ...update().available!, notes } }) })
    render(<UpdateAvailableCard />)

    fireEvent.click(screen.getByRole('link', { name: 'the diff' }))
    expect(opened).toHaveBeenCalledWith(
      'https://github.com/zero-abd/teamree/compare/v0.1.0...v0.2.0',
      '_blank',
      'noopener'
    )
    vi.unstubAllGlobals()
  })

  it('opens the install steps in the browser', () => {
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    render(<UpdateAvailableCard />)

    fireEvent.click(screen.getByRole('link', { name: 'Install steps' }))
    expect(opened).toHaveBeenCalledWith(INSTALL_DOCUMENT, '_blank', 'noopener')
    vi.unstubAllGlobals()
  })

  it('goes away on Later and leaves automatic checks alone', () => {
    render(<UpdateAvailableCard />)

    expect(screen.queryByRole('button', { name: 'Stop checking' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(setAutomaticUpdates).not.toHaveBeenCalled()
    expect(screen.queryByText(/is available/)).toBeNull()
  })

  it('stays away for the same version, across checks and launches', () => {
    const { unmount } = render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    unmount()

    useWorkspaceStore.setState({ update: update({ checkedAt: 1_700_000_600_000 }) })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  it('comes back when a check finds a newer version', () => {
    const { rerender } = render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    const available = { ...update().available!, version: '0.3.0', tag: 'v0.3.0' }
    useWorkspaceStore.setState({ update: update({ available, checkedAt: 1_700_000_600_000 }) })
    rerender(<UpdateAvailableCard />)

    expect(screen.getByText(/teamree 0\.3\.0 is available/)).toBeTruthy()
  })
})

describe('an update fetched in the background', () => {
  const ready = { state: 'ready' as const, version: '0.2.0' }

  it('says it is ready and restarts into it', () => {
    useWorkspaceStore.setState({ update: update({ install: ready }) })
    render(<UpdateAvailableCard />)

    expect(screen.getByText('teamree 0.2.0 is ready')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Install steps' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restart to Update' }))
    expect(restartToUpdate).toHaveBeenCalledTimes(1)
  })

  it('says nothing while it is still being fetched', () => {
    const install = { state: 'downloading' as const, version: '0.2.0', received: 5, total: 100 }
    useWorkspaceStore.setState({ update: update({ install }) })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  it('shows the restart under way until the app quits', async () => {
    let quit: (restarting: boolean) => void = () => {}
    restartToUpdate.mockImplementation(() => new Promise<boolean>((resolve) => (quit = resolve)))
    useWorkspaceStore.setState({ update: update({ install: ready }) })
    render(<UpdateAvailableCard />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart to Update' }))
    const busy = screen.getByRole('button', { name: 'Restarting…' })
    expect(busy.hasAttribute('disabled')).toBe(true)
    quit(true)
    await Promise.resolve()
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeTruthy()
  })

  it('says in one line when macOS refused the swap, offers Settings, and retries on Restart', async () => {
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    restartToUpdate.mockResolvedValue(false)
    const blocked = { ...ready, blocked: { problem: 'macOS blocked the update', settings: true } }
    useWorkspaceStore.setState({ update: update({ install: blocked }) })
    render(<UpdateAvailableCard />)

    expect(screen.getByText('macOS blocked the update')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(opened).toHaveBeenCalledWith(APP_MANAGEMENT_SETTINGS, '_blank', 'noopener')

    fireEvent.click(screen.getByRole('button', { name: 'Restart to Update' }))
    expect(restartToUpdate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Restart to Update' })).toBeTruthy())
    vi.unstubAllGlobals()
  })

  it('offers no Settings when Settings cannot help', () => {
    const blocked = { ...ready, blocked: { problem: "Can't write to /Applications: EACCES", settings: false } }
    useWorkspaceStore.setState({ update: update({ install: blocked }) })
    render(<UpdateAvailableCard />)
    expect(screen.getByText("Can't write to /Applications: EACCES")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })

  it('comes back after Later once a person checks again', () => {
    useWorkspaceStore.setState({ update: update({ install: ready, askedAt: null }) })
    const { rerender } = render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('teamree 0.2.0 is ready')).toBeNull()

    useWorkspaceStore.setState({ update: update({ install: ready, askedAt: Date.now() + 1_000 }) })
    rerender(<UpdateAvailableCard />)
    expect(screen.getByText('teamree 0.2.0 is ready')).toBeTruthy()
  })
})

describe('a smaller card', () => {
  const ready = { state: 'ready' as const, version: '0.2.0' }

  it('minimizes to a pill that keeps Restart to Update, and stays that way until clicked', () => {
    useWorkspaceStore.setState({ update: update({ install: ready }) })
    const { container, unmount } = render(<UpdateAvailableCard />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(container.querySelector('.update-card__notes')).toBeNull()
    expect(screen.getByRole('button', { name: '0.2.0 ready' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart to Update' }))
    expect(restartToUpdate).toHaveBeenCalledTimes(1)
    unmount()

    render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: '0.2.0 ready' }))
    expect(screen.getByText('teamree 0.2.0 is ready')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy()
  })

  it('shows a few lines of the notes and links the whole release', () => {
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    const { container } = render(<UpdateAvailableCard />)

    expect(container.querySelector('.update-card__notes--clipped')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Release Notes' }))
    expect(opened).toHaveBeenCalledWith('https://github.com/zero-abd/teamree/releases/tag/v0.2.0', '_blank', 'noopener')
    vi.unstubAllGlobals()
  })
})

describe('when it stays out of the way', () => {
  it('says nothing when there is no newer release', () => {
    useWorkspaceStore.setState({ update: update({ available: null }) })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  it('says nothing behind a dialog, which would be talking over it', () => {
    useWorkspaceStore.setState({ dialog: { kind: 'clone-project' } })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  // Both are corner cards and both are unprompted. The question asked on a
  // first run is the one that gets answered; a release will keep.
  it('waits while the first-run question about the CLI is on screen', () => {
    useWorkspaceStore.setState({ cli: { ...settledCli(), state: 'absent', resolved: null, askedAt: null } })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  // The modal this card was written before. A question about a teammate's
  // keystrokes is not in `dialog` — nobody in this window opened it — so the
  // check above let it through, and news about a release was drawn under the
  // scrim of a prompt that will not dismiss until it is answered.
  it('says nothing behind a question about a teammate’s keystrokes either', () => {
    useWorkspaceStore.setState({
      consent: {
        p1: {
          projectId: 'p1',
          requests: [
            {
              id: 'ask_1',
              projectId: 'p1',
              terminalId: 't_7',
              handle: 'priya',
              publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
              since: 1_000,
              at: 1_500,
              expiresAt: 2_000,
              writes: 4,
              bytes: 4,
              preview: 'npm test',
              clipped: false
            }
          ],
          standing: [],
          readAt: 1
        }
      }
    })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })
})
