/** @vitest-environment jsdom */

// The card, and the one property of it that is a security property rather than
// a design one: a release body is text from the internet, and this renders it.
//
// The rest is about it being quiet — absent when there is nothing to say,
// out of the way when the first-run question is up, and gone when somebody has
// said they do not want it.

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

const INITIAL = useWorkspaceStore.getState()

const downloadUpdate = vi.fn()
const fetchInstaller = vi.fn()
const openInstaller = vi.fn()
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
  setAutomaticUpdates.mockClear()
  useWorkspaceStore.setState({
    ...INITIAL,
    cli: settledCli(),
    dialog: null,
    update: update(),
    downloadUpdate,
    fetchInstaller,
    openInstaller,
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

  // The one that matters. A release body is attacker-influenceable text in the
  // general case, and this card is the only thing in the app that shows one.
  it('renders release notes as text, so a body full of markup stays a body full of markup', () => {
    const notes = '<img src=x onerror="globalThis.owned = true"><script>globalThis.owned = true</script>'
    useWorkspaceStore.setState({ update: update({ available: { ...update().available!, notes } }) })

    const { container } = render(<UpdateAvailableCard />)

    // The characters are on screen, exactly as written.
    expect(screen.getByText(notes)).toBeTruthy()
    // And no element was made out of them. `querySelector` reads the real DOM,
    // so this fails the moment anything here starts rendering markup.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect((globalThis as Record<string, unknown>).owned).toBeUndefined()
  })

  it('stops the checking and goes away when somebody says so', () => {
    render(<UpdateAvailableCard />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop checking' }))
    expect(setAutomaticUpdates).toHaveBeenCalledWith(false)
    expect(screen.queryByText(/is available/)).toBeNull()
  })

  it('comes back for a check made after it was waved away, because that one was asked for', () => {
    const { rerender } = render(<UpdateAvailableCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop checking' }))
    expect(screen.queryByText(/is available/)).toBeNull()

    useWorkspaceStore.setState({ update: update({ checkedAt: 1_700_000_600_000 }) })
    rerender(<UpdateAvailableCard />)

    expect(screen.getByText(/teamree 0\.2\.0 is available/)).toBeTruthy()
  })
})

describe('when it stays out of the way', () => {
  it('says nothing when there is no newer release', () => {
    useWorkspaceStore.setState({ update: update({ available: null }) })
    const { container } = render(<UpdateAvailableCard />)
    expect(container.querySelector('.update-card')).toBeNull()
  })

  it('says nothing behind a dialog, which would be talking over it', () => {
    useWorkspaceStore.setState({ dialog: { kind: 'add-project' } })
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
