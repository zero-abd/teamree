// Told once when there is something to tell, and never bothered otherwise.
// The "does not happen" cases would rot invisibly.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../store/workspaceStore'
import type { LatestRelease } from './latestRelease'
import { AUTOMATIC_CHECK_INTERVAL_MS, UpdateService, type UpdateSettingsRecord } from './updateService'

const NOW = 1_700_000_000_000
const REPOSITORY = 'owner/project'

function found(overrides: Partial<LatestRelease> = {}): LatestRelease {
  return {
    version: '0.2.0',
    tag: 'v0.2.0',
    prerelease: false,
    notes: 'Faster panes.',
    downloadUrl: `https://github.com/${REPOSITORY}/releases/download/v0.2.0/teamree-mac-universal.dmg`,
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v0.2.0`,
    publishedAt: NOW,
    ...overrides
  }
}

/** The preference and the clock, in memory, so most tests need no disk. */
function settings(initial: Partial<Record<string, unknown>> = {}) {
  const held = {
    automatic: true,
    lastCheckedAt: null as number | null,
    lastSeenVersion: null as string | null,
    ...initial
  }
  const record: UpdateSettingsRecord = {
    read: () => ({ ...held }),
    setAutomatic: (automatic) => {
      held.automatic = automatic
    },
    recordAttempt: (at) => {
      held.lastCheckedAt = at
    },
    rememberLatest: (version) => {
      held.lastSeenVersion = version
    }
  }
  return { record, held }
}

type ServiceOptions = {
  version?: string
  readRelease?: (channel: 'stable' | 'prerelease') => Promise<LatestRelease | null>
  now?: () => number
  record?: UpdateSettingsRecord
  openExternal?: (url: string) => Promise<void>
}

function service(options: ServiceOptions = {}) {
  const changes: number[] = []
  const problems: string[] = []
  const record = options.record ?? settings().record
  const update = new UpdateService({
    version: options.version ?? '0.1.0',
    repository: REPOSITORY,
    settings: record,
    readRelease: options.readRelease ?? (async () => found()),
    openExternal: options.openExternal,
    now: options.now ?? (() => NOW),
    onChange: () => changes.push(changes.length),
    onProblem: (message) => problems.push(message)
  })
  return { update, changes, problems }
}

describe('when there is a newer release', () => {
  it('offers it, with the version, the notes and the download', async () => {
    const { update, changes } = service()
    const state = await update.check({ force: true })

    expect(state.available).toMatchObject({ version: '0.2.0', tag: 'v0.2.0', notes: 'Faster panes.' })
    expect(state.available?.downloadUrl).toContain('.dmg')
    expect(state.problem).toBeNull()
    // The window is told: the menu item and the startup timer both land here.
    expect(changes.length).toBeGreaterThan(0)
  })

  it('opens the download it is holding, and takes no address to do it', async () => {
    const opened: string[] = []
    const { update } = service({
      openExternal: async (url) => {
        opened.push(url)
      }
    })
    await update.check({ force: true })
    await update.openDownload()

    expect(opened).toEqual([found().downloadUrl])
  })

  it('offers the release page when the release published no image', async () => {
    const opened: string[] = []
    const { update } = service({
      readRelease: async () => found({ downloadUrl: null }),
      openExternal: async (url) => {
        opened.push(url)
      }
    })
    await update.check({ force: true })
    await update.openDownload()

    expect(opened).toEqual([`https://github.com/${REPOSITORY}/releases/tag/v0.2.0`])
  })
})

describe('when there is not', () => {
  it('says nothing about the same version', async () => {
    const { update } = service({ version: '0.2.0' })
    expect((await update.check({ force: true })).available).toBeNull()
  })

  it('says nothing about an older one, whatever the release page claims is latest', async () => {
    const { update } = service({ version: '0.3.0' })
    expect((await update.check({ force: true })).available).toBeNull()
  })

  it('says nothing at all when the repository has no releases', async () => {
    const { update, problems } = service({ readRelease: async () => null })
    const state = await update.check({ force: true })
    expect(state.available).toBeNull()
    expect(state.problem).toBeNull()
    expect(problems).toEqual([])
  })
})

describe('pre-releases', () => {
  it('asks for the stable release when this build is a stable one', async () => {
    const channels: string[] = []
    const { update } = service({
      version: '0.1.0',
      readRelease: async (channel) => {
        channels.push(channel)
        return found()
      }
    })
    await update.check({ force: true })
    expect(channels).toEqual(['stable'])
  })

  // Belt and braces over the endpoint's own filtering.
  it('refuses a candidate that reaches a stable build regardless', async () => {
    const { update } = service({
      version: '0.1.0',
      readRelease: async () => found({ version: '0.3.0-rc.1', tag: 'v0.3.0-rc.1', prerelease: true })
    })
    expect((await update.check({ force: true })).available).toBeNull()
  })

  it('asks for, and offers, candidates to somebody already running one', async () => {
    const channels: string[] = []
    const { update } = service({
      version: '0.3.0-rc.1',
      readRelease: async (channel) => {
        channels.push(channel)
        return found({ version: '0.3.0-rc.2', tag: 'v0.3.0-rc.2', prerelease: true })
      }
    })
    const state = await update.check({ force: true })
    expect(channels).toEqual(['prerelease'])
    expect(state.available?.version).toBe('0.3.0-rc.2')
  })
})

describe('a check that could not be made', () => {
  it('is a log line and nothing else', async () => {
    const { update, problems } = service({
      readRelease: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      }
    })
    const state = await update.check({ force: true })

    expect(state.available).toBeNull()
    expect(state.problem).toContain('ENOTFOUND')
    expect(problems).toHaveLength(1)
  })

  it('leaves what an earlier check learned alone', async () => {
    const { record, held } = settings({ lastSeenVersion: '0.2.0' })
    const { update } = service({
      record,
      readRelease: async () => {
        throw new Error('offline')
      }
    })
    const state = await update.check({ force: true })

    expect(held.lastSeenVersion).toBe('0.2.0')
    // Still offered off the release page: the notes were never written down.
    expect(state.available).toMatchObject({ version: '0.2.0', notes: null, downloadUrl: null })
  })

  it('still counts against the rate limit, because a refused request was a request', async () => {
    const { record, held } = settings()
    const { update } = service({
      record,
      readRelease: async () => {
        throw new Error('offline')
      }
    })
    await update.check({ force: true })
    expect(held.lastCheckedAt).toBe(NOW)
  })
})

describe('how often GitHub is asked', () => {
  it('does not ask again inside the interval, unless a person asked', async () => {
    let asks = 0
    const { record } = settings({ lastCheckedAt: NOW - 60_000 })
    const { update } = service({
      record,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    await update.check()
    expect(asks).toBe(0)

    // The limit is about what the app does unasked.
    await update.check({ force: true })
    expect(asks).toBe(1)
  })

  it('asks again once the interval has passed', async () => {
    let asks = 0
    const { record } = settings({ lastCheckedAt: NOW - AUTOMATIC_CHECK_INTERVAL_MS - 1 })
    const { update } = service({
      record,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })
    await update.check()
    expect(asks).toBe(1)
  })

  // The case in-memory state cannot see.
  it('remembers across a restart, because the clock is on disk', async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), 'teamree-updates-')), 'workspace.json')
    let asks = 0
    const readRelease = async (): Promise<LatestRelease> => {
      asks += 1
      return found()
    }
    const open = async (): Promise<WorkspaceStore> => WorkspaceStore.open(filePath, { now: () => NOW })
    const from = (store: WorkspaceStore, now: number): UpdateService =>
      new UpdateService({
        version: '0.1.0',
        repository: REPOSITORY,
        settings: {
          read: () => store.updateSettings(),
          setAutomatic: (automatic) => store.setUpdateAutomatic(automatic),
          recordAttempt: (at) => store.recordUpdateCheck(at),
          rememberLatest: (version) => store.rememberLatestVersion(version)
        },
        readRelease,
        now: () => now
      })

    const first = await open()
    await from(first, NOW).check()
    await first.flush()
    expect(asks).toBe(1)

    // A different process, a minute later, reading the file the first one left.
    const second = await open()
    const relaunched = from(second, NOW + 60_000)
    const state = await relaunched.check()
    expect(asks).toBe(1)
    // Nothing was asked, and the window is still told what the last run found.
    expect(state.available).toMatchObject({ version: '0.2.0', downloadUrl: null })

    const third = await open()
    await from(third, NOW + AUTOMATIC_CHECK_INTERVAL_MS + 1).check()
    expect(asks).toBe(2)
  })

  it('joins the check already running rather than starting a second one', async () => {
    let asks = 0
    const { update } = service({
      readRelease: async () => {
        asks += 1
        return found()
      }
    })
    const [a, b] = await Promise.all([update.check({ force: true }), update.check({ force: true })])
    expect(asks).toBe(1)
    expect(a.available?.version).toBe(b.available?.version)
  })
})

describe('the preference', () => {
  it('is remembered, and stops the automatic check from being armed at all', () => {
    const { record, held } = settings()
    // The preference is read when the check fires, not when it was armed.
    let fire: (() => void) | undefined
    let armed = 0
    const update = new UpdateService({
      version: '0.1.0',
      repository: REPOSITORY,
      settings: record,
      readRelease: async () => found(),
      schedule: (run) => {
        armed += 1
        fire = run
        return () => {}
      }
    })

    update.setAutomatic(false)
    expect(held.automatic).toBe(false)
    expect(update.state().automatic).toBe(false)

    // Armed either way, so turning it off in the first half-minute stops the first check.
    update.start()
    expect(armed).toBe(1)
    fire?.()
    expect(update.state().checkedAt).toBeNull()
  })

  it('does not stop a person checking by hand', async () => {
    const { record } = settings({ automatic: false })
    const { update } = service({ record })
    expect((await update.check({ force: true })).available?.version).toBe('0.2.0')
  })

  // The version is still on disk; every launch would otherwise offer it.
  it('stops offering what an earlier run found, once it is off', () => {
    const { record } = settings({ automatic: false, lastSeenVersion: '0.2.0' })
    const { update } = service({ record })
    expect(update.state().available).toBeNull()
  })
})

describe('a build that is not a release', () => {
  // `npm run dev` reports 0.0.0-dev, which every published version is newer than.
  it('asks nobody anything, and says why', async () => {
    let asks = 0
    const { update } = service({
      version: '0.0.0-dev',
      readRelease: async () => {
        asks += 1
        return found()
      }
    })
    const state = await update.check({ force: true })

    expect(asks).toBe(0)
    expect(state.checkable).toBe(false)
    expect(state.available).toBeNull()
    expect(state.problem).toContain('0.0.0-dev')
  })

  it('does not arm the automatic check either', () => {
    let armed = 0
    const update = new UpdateService({
      version: '0.0.0-dev',
      settings: settings().record,
      readRelease: async () => found(),
      schedule: () => {
        armed += 1
        return () => {}
      }
    })
    update.start()
    expect(armed).toBe(0)
  })
})

describe('opening a download', () => {
  it('refuses when there is nothing newer to open', async () => {
    const { update } = service({ version: '0.2.0', openExternal: async () => {} })
    await update.check({ force: true })
    await expect(update.openDownload()).rejects.toThrow(/no newer release/)
  })
})
