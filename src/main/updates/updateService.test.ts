// Told once when there is something to tell, and never bothered otherwise.
// The "does not happen" cases would rot invisibly.

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { WorkspaceStore } from '../store/workspaceStore'
import type { HostPolicy } from './downloadInstaller'
import type { LatestRelease } from './latestRelease'
import type { SelfInstall } from './selfInstaller'
import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  AUTOMATIC_CHECK_THROTTLE_MS,
  FOCUS_RECHECK_AFTER_MS,
  STARTUP_CHECK_DELAY_MS,
  UpdateService,
  type UpdateSettingsRecord
} from './updateService'
import type { WakeWatch } from './wakeWatch'

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
    installer: null,
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
  downloadsDirectory?: string
  openPath?: (path: string) => Promise<string>
  allowDownload?: HostPolicy
  watchWake?: WakeWatch
}

/** A clock a test can move by hand, for the checks a real timer would not fire in a unit test. */
function movableClock(start: number): { now: () => number; advance: (byMs: number) => void } {
  let at = start
  return { now: () => at, advance: (byMs) => (at += byMs) }
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
    downloadsDirectory: options.downloadsDirectory,
    openPath: options.openPath,
    allowDownload: options.allowDownload,
    watchWake: options.watchWake,
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
  it('does not ask again inside the throttle, unless a person asked', async () => {
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

  it('asks again once the throttle has passed', async () => {
    let asks = 0
    const { record } = settings({ lastCheckedAt: NOW - AUTOMATIC_CHECK_THROTTLE_MS - 1 })
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

  // Named, so a change to any of these is a deliberate one.
  it('is 10 seconds after launch, every hour, throttled to once per 10 minutes', () => {
    expect(STARTUP_CHECK_DELAY_MS).toBe(10_000)
    expect(AUTOMATIC_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(AUTOMATIC_CHECK_THROTTLE_MS).toBe(10 * 60 * 1000)
    expect(FOCUS_RECHECK_AFTER_MS).toBe(30 * 60 * 1000)
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
    await from(third, NOW + AUTOMATIC_CHECK_THROTTLE_MS + 1).check()
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

describe('waking from sleep', () => {
  it('checks once the machine wakes, through the same throttle as the clock', async () => {
    let asks = 0
    let onWake: (() => void) | undefined
    const watchWake: WakeWatch = async (onWakeCallback) => {
      onWake = onWakeCallback
      return () => {}
    }
    const { record } = settings({ lastCheckedAt: NOW - AUTOMATIC_CHECK_THROTTLE_MS - 1 })
    const { update } = service({
      record,
      watchWake,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.start()
    await vi.waitFor(() => expect(onWake).toBeDefined())
    onWake?.()
    await vi.waitFor(() => expect(asks).toBe(1))
  })

  it('says nothing when a wake lands inside the throttle', async () => {
    let asks = 0
    let onWake: (() => void) | undefined
    const watchWake: WakeWatch = async (onWakeCallback) => {
      onWake = onWakeCallback
      return () => {}
    }
    const { record } = settings({ lastCheckedAt: NOW - 60_000 })
    const { update } = service({
      record,
      watchWake,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.start()
    await vi.waitFor(() => expect(onWake).toBeDefined())
    onWake?.()
    expect(asks).toBe(0)
  })

  it('says nothing when the preference is off', async () => {
    let asks = 0
    let onWake: (() => void) | undefined
    const watchWake: WakeWatch = async (onWakeCallback) => {
      onWake = onWakeCallback
      return () => {}
    }
    const { record } = settings({ automatic: false, lastCheckedAt: NOW - AUTOMATIC_CHECK_THROTTLE_MS - 1 })
    const { update } = service({
      record,
      watchWake,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.start()
    await vi.waitFor(() => expect(onWake).toBeDefined())
    onWake?.()
    expect(asks).toBe(0)
  })

  it('unsubscribes when the service stops', async () => {
    let unwatched = 0
    const watchWake: WakeWatch = async () => () => {
      unwatched += 1
    }
    const { update } = service({ watchWake })

    update.start()
    await vi.waitFor(() => expect(unwatched).toBe(0))
    update.stop()
    await vi.waitFor(() => expect(unwatched).toBe(1))
  })
})

describe('the window’s return', () => {
  it('checks when focus comes back after 30 or more minutes away', async () => {
    let asks = 0
    const clock = movableClock(NOW - AUTOMATIC_CHECK_THROTTLE_MS - 1)
    const { record } = settings({ lastCheckedAt: clock.now() })
    const { update } = service({
      record,
      now: clock.now,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.noteWindowBlur()
    clock.advance(FOCUS_RECHECK_AFTER_MS)
    update.noteWindowFocus()
    await vi.waitFor(() => expect(asks).toBe(1))
  })

  it('says nothing about a short absence', async () => {
    let asks = 0
    const clock = movableClock(NOW)
    const { update } = service({
      now: clock.now,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.noteWindowBlur()
    clock.advance(FOCUS_RECHECK_AFTER_MS - 1)
    update.noteWindowFocus()
    expect(asks).toBe(0)
  })

  it('says nothing about a focus with no blur before it', async () => {
    let asks = 0
    const { update } = service({
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.noteWindowFocus()
    expect(asks).toBe(0)
  })

  it('does not check twice for the same absence', async () => {
    let asks = 0
    const clock = movableClock(NOW - AUTOMATIC_CHECK_THROTTLE_MS - 1)
    const { record } = settings({ lastCheckedAt: clock.now() })
    const { update } = service({
      record,
      now: clock.now,
      readRelease: async () => {
        asks += 1
        return found()
      }
    })

    update.noteWindowBlur()
    clock.advance(FOCUS_RECHECK_AFTER_MS)
    update.noteWindowFocus()
    await vi.waitFor(() => expect(asks).toBe(1))
    update.noteWindowFocus()
    expect(asks).toBe(1)
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

describe('fetching the installer', () => {
  const BYTES = Buffer.alloc(200_000, 3)
  const SHA = createHash('sha256').update(BYTES).digest('hex')

  /** A local stand-in for GitHub's storage, and a policy that allows only it. */
  async function fixture(): Promise<{ url: string; allowed: HostPolicy; close: () => Promise<void> }> {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': BYTES.length }).end(BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      url: `${origin}/teamree-0.2.0.dmg`,
      allowed: (url) => new URL(url).origin === origin,
      close: () => new Promise((resolve) => server.close(() => resolve()))
    }
  }

  async function prepared(sha256: string = SHA) {
    const local = await fixture()
    const directory = await mkdtemp(join(tmpdir(), 'teamree-downloads-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const opened: string[] = []
    const installer = { url: local.url, name: 'teamree-0.2.0.dmg', size: BYTES.length, sha256 }
    const made = service({
      readRelease: async () => found({ installer }),
      downloadsDirectory: directory,
      openPath: async (path) => {
        opened.push(path)
        return ''
      },
      allowDownload: local.allowed
    })
    await made.update.check({ force: true })
    return { ...made, directory, opened, close: local.close }
  }

  it('offers it with its size, downloads it into Downloads, and opens only that file', async () => {
    const { update, directory, opened, close } = await prepared()
    expect(update.state().available?.installer).toEqual({ name: 'teamree-0.2.0.dmg', size: BYTES.length })

    const started = await update.fetchInstaller()
    expect(started.download).toMatchObject({ state: 'downloading', version: '0.2.0', total: BYTES.length })
    await vi.waitFor(() => expect(update.state().download?.state).toBe('ready'))
    const path = join(directory, 'teamree-0.2.0.dmg')
    expect(update.state().download).toEqual({ state: 'ready', version: '0.2.0', path })

    await expect(update.openInstaller()).resolves.toEqual({ opened: path })
    expect(opened).toEqual([path])
    await close()
  })

  it('deletes the file and says so when the checksum does not match', async () => {
    const { update, directory, opened, close } = await prepared('0'.repeat(64))
    await update.fetchInstaller()
    await vi.waitFor(() => expect(update.state().download?.state).toBe('failed'))

    expect(update.state().download).toMatchObject({ problem: 'Checksum mismatch; the file was deleted.' })
    expect(await readdir(directory)).toEqual([])
    await expect(update.openInstaller()).rejects.toThrow(/no installer/)
    expect(opened).toEqual([])
    await close()
  })

  it('refuses a link outside the release host, with the real policy, before asking anyone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamree-downloads-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const installer = { url: 'https://example.invalid/x.dmg', name: 'x.dmg', size: 1, sha256: SHA }
    const { update } = service({ readRelease: async () => found({ installer }), downloadsDirectory: directory })
    await update.check({ force: true })
    await update.fetchInstaller()

    await vi.waitFor(() => expect(update.state().download?.state).toBe('failed'))
    expect(update.state().download).toMatchObject({ problem: 'Download failed: refused example.invalid' })
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses when the release has no installer it can verify', async () => {
    const { update } = service({ downloadsDirectory: '/nowhere' })
    await update.check({ force: true })
    await expect(update.fetchInstaller()).rejects.toThrow(/no installer/)
  })
})

describe('replacing this copy in place', () => {
  function installer(overrides: Partial<SelfInstall> = {}) {
    const calls = { prepared: [] as string[], armed: [] as [string, boolean][], launched: 0, disarmed: 0 }
    const self: SelfInstall = {
      refusal: async () => null,
      prepare: async (release, options) => {
        calls.prepared.push(release.version)
        options.onSize?.(100)
        options.onProgress?.(50)
        options.onProgress?.(100)
      },
      recover: async () => null,
      arm: async (version, foreground) => {
        calls.armed.push([version, foreground])
      },
      launch: () => {
        calls.launched += 1
      },
      disarm: () => {
        calls.disarmed += 1
      },
      preflight: async () => null,
      ...overrides
    }
    return { self, calls }
  }

  function installing(
    options: { self?: SelfInstall; version?: string; readRelease?: () => Promise<LatestRelease | null> } = {}
  ) {
    const restarts: number[] = []
    const problems: string[] = []
    const delays: number[] = []
    let fire: (() => void) | undefined
    const update = new UpdateService({
      version: options.version ?? '0.1.0',
      repository: REPOSITORY,
      settings: settings().record,
      readRelease: options.readRelease ?? (async () => found()),
      selfInstall: options.self ?? installer().self,
      restart: () => restarts.push(1),
      now: () => NOW,
      onProblem: (message) => problems.push(message),
      schedule: (run, delay) => {
        delays.push(delay)
        fire = run
        return () => {}
      }
    })
    return { update, restarts, problems, delays, tick: () => fire?.() }
  }

  it('fetches a newer release in the background and says when it is ready', async () => {
    const { self, calls } = installer()
    const { update } = installing({ self })
    const checked = await update.check({ force: true })

    expect(checked.install).toMatchObject({ state: 'downloading', version: '0.2.0' })
    await vi.waitFor(() => expect(update.state().install).toEqual({ state: 'ready', version: '0.2.0' }))
    expect(calls.prepared).toEqual(['0.2.0'])

    await update.check({ force: true })
    expect(calls.prepared).toEqual(['0.2.0'])
  })

  it('never fetches the same, an older, or a candidate release on the stable channel', async () => {
    for (const [version, release] of [
      ['0.2.0', found()],
      ['0.3.0', found()],
      ['0.1.0', found({ version: '0.3.0-rc.1', tag: 'v0.3.0-rc.1', prerelease: true })]
    ] as const) {
      const { self, calls } = installer()
      const { update } = installing({ self, version, readRelease: async () => release })
      await update.check({ force: true })
      expect(update.state().install ?? null, version).toBeNull()
      expect(calls.prepared).toEqual([])
    }
  })

  it('leaves the disk image as the way when this copy cannot replace itself', async () => {
    const { self, calls } = installer({ refusal: async () => 'it is running translocated' })
    const { update, problems } = installing({ self })
    await update.check({ force: true })

    await vi.waitFor(() => expect(update.state().install).toBeNull())
    expect(calls.prepared).toEqual([])
    expect(problems.join('\n')).toContain('translocated')
  })

  it('says why a fetch failed, and tries again at the next check', async () => {
    let attempts = 0
    const { self } = installer({
      prepare: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('teamree-mac.json does not match the release')
      }
    })
    const { update } = installing({ self })
    await update.check({ force: true })
    await vi.waitFor(() => expect(update.state().install?.state).toBe('failed'))
    expect(update.state().install).toMatchObject({ problem: expect.stringContaining('does not match') })

    await update.check({ force: true })
    await vi.waitFor(() => expect(update.state().install?.state).toBe('ready'))
  })

  it('restarts only once ready, through the app’s own quit, and swaps only once the quit is past its questions', async () => {
    const { self, calls } = installer()
    const { update, restarts } = installing({ self })
    await expect(update.restartToUpdate()).rejects.toThrow(/no update ready/)

    await update.check({ force: true })
    await vi.waitFor(() => expect(update.state().install?.state).toBe('ready'))
    await expect(update.restartToUpdate()).resolves.toEqual({ restarting: '0.2.0' })
    expect(calls.armed).toEqual([['0.2.0', true]])
    expect(restarts).toHaveLength(1)
    expect(calls.launched).toBe(0)

    update.stop()
    expect(calls.launched).toBe(1)
  })

  it('does not quit when the swap would be refused, says why on the card, and quits once it would not', async () => {
    const blocked = { problem: 'macOS won’t let teamree replace itself', settings: true }
    let answer: typeof blocked | null = blocked
    const { self, calls } = installer({ preflight: async () => answer })
    const { update, restarts } = installing({ self })
    await update.check({ force: true })
    await vi.waitFor(() => expect(update.state().install?.state).toBe('ready'))

    await expect(update.restartToUpdate()).resolves.toEqual({ blocked: blocked.problem })
    expect(update.state().install).toEqual({ state: 'ready', version: '0.2.0', blocked })
    expect(calls.armed).toEqual([])
    expect(restarts).toHaveLength(0)

    answer = null
    await expect(update.restartToUpdate()).resolves.toEqual({ restarting: '0.2.0' })
    expect(update.state().install).toEqual({ state: 'ready', version: '0.2.0' })
    expect(restarts).toHaveLength(1)
  })

  it('installs nothing on a later quit when this one was declined', () => {
    const { self, calls } = installer()
    const { update } = installing({ self })
    update.quitDeclined()
    expect(calls.disarmed).toBe(1)
  })

  it('offers a copy an earlier run fetched, without fetching it again', async () => {
    const { self, calls } = installer({ recover: async (wanted) => (wanted('0.2.0') ? '0.2.0' : null) })
    const { update, tick } = installing({ self })
    update.start()
    tick()
    await vi.waitFor(() => expect(update.state().install).toEqual({ state: 'ready', version: '0.2.0' }))
    expect(calls.prepared).toEqual([])
  })

  it('checks on launch and again every interval', async () => {
    const { update, delays, tick } = installing()
    update.start()
    tick()
    tick()
    expect(delays).toEqual([STARTUP_CHECK_DELAY_MS, AUTOMATIC_CHECK_INTERVAL_MS, AUTOMATIC_CHECK_INTERVAL_MS])
  })

  it('remembers when a person asked, so a card put off with Later comes back', async () => {
    const { update } = installing()
    await update.check({ force: true })
    expect(update.state().askedAt).toBeNull()
    await update.check({ force: true, person: true })
    expect(update.state().askedAt).toBe(NOW)
  })

  it('takes a download host other than the release’s only inside the test runner', () => {
    const vitest = process.env['VITEST']
    delete process.env['VITEST']
    try {
      expect(
        () => new UpdateService({ version: '0.1.0', settings: settings().record, allowDownload: () => true })
      ).toThrow(/tests/)
    } finally {
      process.env['VITEST'] = vitest
    }
  })
})
