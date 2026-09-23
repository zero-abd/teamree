// What the window does with a check, which is mostly nothing. A check the app
// made by itself may only produce the card; one somebody asked for must answer
// even with "you are current".

import { expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/entities'

const call = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params) as Promise<unknown>,
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    current: '0.1.0',
    checkable: true,
    automatic: true,
    available: null,
    checking: false,
    checkedAt: 1_700_000_000_000,
    problem: null,
    ...overrides
  }
}

function reset(): void {
  call.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, update: null, notices: [] })
}

const notices = (): string[] => useWorkspaceStore.getState().notices.map((notice) => notice.text)

it('says so when a check somebody asked for finds nothing, because silence would read as broken', async () => {
  reset()
  call.mockResolvedValue(state())

  await useWorkspaceStore.getState().checkForUpdates()

  expect(call).toHaveBeenCalledWith('update.check', {})
  expect(notices()).toEqual(['teamree 0.1.0 is the latest release.'])
})

it('says nothing extra when the check found something: the card is the answer', async () => {
  reset()
  call.mockResolvedValue(
    state({
      available: {
        version: '0.2.0',
        tag: 'v0.2.0',
        notes: null,
        downloadUrl: null,
        releaseUrl: 'https://github.com/zero-abd/teamree/releases/tag/v0.2.0',
        publishedAt: null
      }
    })
  )

  await useWorkspaceStore.getState().checkForUpdates()

  expect(notices()).toEqual([])
  expect(useWorkspaceStore.getState().update?.available?.version).toBe('0.2.0')
})

it('reports a check that could not be made, because this one was asked for', async () => {
  reset()
  call.mockResolvedValue(state({ problem: 'GitHub answered 403 for stable releases' }))

  await useWorkspaceStore.getState().checkForUpdates()

  expect(notices()[0]).toContain('403')
})

// The read the window makes at startup and whenever the check has news. A
// machine with no network must cost the user nothing, including a notice.
it('is silent when the read itself fails, which is how a check nobody asked for fails', async () => {
  reset()
  call.mockRejectedValue(new Error('runtime is not answering'))

  await useWorkspaceStore.getState().loadUpdate()

  expect(notices()).toEqual([])
  expect(useWorkspaceStore.getState().update).toBeNull()
})

it('remembers the preference the way the runtime answers it, not the way it was asked', async () => {
  reset()
  useWorkspaceStore.setState({ update: state() })
  call.mockResolvedValue(state({ automatic: false }))

  await useWorkspaceStore.getState().setAutomaticUpdates(false)

  expect(call).toHaveBeenCalledWith('update.setAutomatic', { automatic: false })
  expect(useWorkspaceStore.getState().update?.automatic).toBe(false)
})

it('puts the preference back when the runtime could not record it', async () => {
  reset()
  useWorkspaceStore.setState({ update: state({ automatic: true }) })
  call.mockRejectedValue(new Error('nothing is being saved'))

  await useWorkspaceStore.getState().setAutomaticUpdates(false)

  expect(useWorkspaceStore.getState().update?.automatic).toBe(true)
  expect(notices()[0]).toContain('Could not change whether teamree checks for updates')
})

it('starts the installer download and keeps the state the runtime answers with', async () => {
  reset()
  const download = { state: 'downloading' as const, version: '0.2.0', received: 0, total: 10 }
  call.mockResolvedValue(state({ download }))

  await useWorkspaceStore.getState().fetchInstaller()

  expect(call).toHaveBeenCalledWith('update.fetchInstaller', {})
  expect(useWorkspaceStore.getState().update?.download).toEqual(download)
})

it('opens the installer, and says so when it could not', async () => {
  reset()
  call.mockResolvedValueOnce({ opened: '/Users/me/Downloads/teamree-0.2.0.dmg' })
  await useWorkspaceStore.getState().openInstaller()
  expect(call).toHaveBeenCalledWith('update.openInstaller', {})
  expect(notices()).toEqual([])

  call.mockRejectedValue(new Error('the file is gone'))
  await useWorkspaceStore.getState().openInstaller()
  expect(notices()[0]).toContain('Could not open the installer')
})
