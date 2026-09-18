// Everything here drives the service through its seams: the destination
// directory is a fresh temporary one and the privileged runner is a function
// this file wrote. Nothing in this suite can reach /usr/local/bin, which is the
// point — an installer whose tests need the real root of the filesystem is an
// installer nobody can change safely.

import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'
import { CliService, type CliServiceOptions } from './cliService'

const run = promisify(execFile)

const scratches: string[] = []

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/**
 * An app bundle with a CLI in it, at a path awkward enough to be interesting.
 *
 * The launcher and the Node bundle it runs, because that is what
 * `extraResources` puts there: a launcher on its own is what a checkout has
 * before `npm run build:cli`, and it is not an app anybody can run.
 */
async function scratchApp(appName = 'my "teamree" copy.app'): Promise<{ root: string; source: string; bin: string }> {
  // Canonical, because the service resolves the link it made and compares it
  // with the app's own path: on macOS a temporary directory is reached through
  // a symlink, and an uncanonicalised root would have this suite disagree with
  // itself there and nowhere else.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tmr-cli-')))
  scratches.push(root)
  const resources = join(root, appName, 'Contents', 'Resources', 'cli')
  await mkdir(resources, { recursive: true })
  const source = join(resources, 'teamree')
  await writeFile(source, '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(resources, 'teamree.mjs'), 'process.exit(0)\n')
  const bin = join(root, 'bin')
  await mkdir(bin)
  return { root, source, bin }
}

/** A source checkout: the launcher is in it, and nothing has built the bundle. */
async function scratchCheckout(): Promise<{ source: string; bin: string; bundle: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tmr-cli-')))
  scratches.push(root)
  const repo = join(root, 'teamree')
  await mkdir(join(repo, 'resources', 'cli'), { recursive: true })
  const source = join(repo, 'resources', 'cli', 'teamree')
  await writeFile(source, '#!/bin/sh\n', { mode: 0o755 })
  const bin = join(root, 'bin')
  await mkdir(bin)
  return { source, bin, bundle: join(repo, 'out', 'cli', 'index.js') }
}

type Harness = { service: CliService; escalated: string[] }

function harness(options: Partial<CliServiceOptions> & { directory: string }): Harness {
  const escalated: string[] = []
  const service = new CliService({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    loginPaths: async () => [],
    // Undefined by default: "the login shell could not be asked", which is the
    // state in which /etc/paths is consulted at all. A test that wants the
    // shell consulted says so, rather than every other test in this file
    // silently starting a real zsh and answering for the machine it runs on.
    shellPath: () => undefined,
    writable: async () => true,
    administrator: async (command) => {
      escalated.push(command)
    },
    source: null,
    ...options
  })
  return { service, escalated }
}

describe('what is at the destination', () => {
  it('reports nothing there, and where it would go', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('absent')
    expect(status.destination).toBe(join(bin, 'teamree'))
    expect(status.directory).toBe(bin)
    expect(status.source).toBe(source)
    expect(status.resolved).toBeNull()
    expect(status.installable).toBe(true)
  })

  it('knows a link that already points at this app', async () => {
    const { source, bin } = await scratchApp()
    await symlink(source, join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('linked')
    expect(status.resolved).toBe(source)
  })

  it('names the other teamree a link points at', async () => {
    const { source, bin, root } = await scratchApp()
    const older = join(root, 'Downloads', 'teamree.app', 'Contents', 'Resources', 'cli')
    await mkdir(older, { recursive: true })
    await writeFile(join(older, 'teamree'), '#!/bin/sh\n')
    await symlink(join(older, 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('elsewhere')
    expect(status.resolved).toBe(join(older, 'teamree'))
  })

  it('reports a dangling link as pointing elsewhere rather than as nothing', async () => {
    const { source, bin, root } = await scratchApp()
    await symlink(join(root, 'gone', 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('elsewhere')
    expect(status.resolved).toBe(join(root, 'gone', 'teamree'))
  })

  it('tells a regular file from a directory', async () => {
    const { source, bin } = await scratchApp()
    await writeFile(join(bin, 'teamree'), 'somebody else’s binary')
    const { service } = harness({ source, directory: bin })
    expect((await service.status()).state).toBe('file')

    await rm(join(bin, 'teamree'))
    await mkdir(join(bin, 'teamree'))
    expect((await service.status()).state).toBe('directory')
  })

  it('says a password will be asked for when the directory cannot be written', async () => {
    const { source, bin } = await scratchApp()
    const writable = harness({ source, directory: bin, writable: async () => true })
    expect((await writable.service.status()).needsAdministrator).toBe(false)

    const locked = harness({ source, directory: bin, writable: async () => false })
    expect((await locked.service.status()).needsAdministrator).toBe(true)
  })
})

describe('the bundle behind the launcher', () => {
  it('resolves it the way the launcher does, in both places the launcher looks', async () => {
    const app = await scratchApp()
    expect((await harness({ source: app.source, directory: app.bin }).service.status()).bundle).toBe(
      join(dirname(app.source), 'teamree.mjs')
    )

    const checkout = await scratchCheckout()
    await mkdir(dirname(checkout.bundle), { recursive: true })
    await writeFile(checkout.bundle, 'process.exit(0)\n')
    expect((await harness({ source: checkout.source, directory: checkout.bin }).service.status()).bundle).toBe(
      checkout.bundle
    )
  })

  it('has none when nothing has built it, which is every checkout before npm run build:cli', async () => {
    const { source, bin } = await scratchCheckout()
    expect((await harness({ source, directory: bin }).service.status()).bundle).toBeNull()
  })

  it('refuses to link a launcher with no bundle behind it, and asks for no password to do it', async () => {
    const { source, bin } = await scratchCheckout()
    const { service, escalated } = harness({ source, directory: bin, writable: async () => false })

    await expect(service.install()).rejects.toThrow(/npm run build:cli/)
    await expect(service.install()).rejects.toMatchObject({ code: ErrorCode.NotFound })
    await expect(lstat(join(bin, 'teamree'))).rejects.toThrow()
    expect(escalated).toEqual([])
  })
})

describe('whether the destination is on PATH', () => {
  it('finds it in this process’s own PATH', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, env: { PATH: `/usr/bin:${bin}:/bin` } })
    expect((await service.status()).onPath).toBe('environment')
  })

  it('ignores a trailing slash, which PATH entries are allowed to carry', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, env: { PATH: `${bin}/:/bin` } })
    expect((await service.status()).onPath).toBe('environment')
  })

  it('falls back to the login PATH an app started from Finder never sees', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({
      source,
      directory: bin,
      env: { PATH: '/usr/bin:/bin' },
      loginPaths: async () => [bin]
    })
    expect((await service.status()).onPath).toBe('login')
  })

  // The login shell is the PATH of the terminal somebody will actually type in,
  // so when it can be asked it is the whole answer — including when the answer
  // is no.
  it('takes the login shell’s own PATH over everything else', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({
      source,
      directory: bin,
      env: { PATH: '/usr/bin:/bin' },
      shellPath: () => `/opt/homebrew/bin:${bin}:/usr/bin`
    })
    expect((await service.status()).onPath).toBe('shell')
  })

  // The defect this seam exists for. `/etc/paths` is the PATH a shell *starts*
  // with, and a profile that assigns PATH rather than extending it throws it
  // away — so /etc/paths said yes, the terminal said no, and the app reported
  // yes with no hedge, after charging an administrator password for the link.
  it('believes the shell over /etc/paths when the two disagree', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({
      source,
      directory: bin,
      env: { PATH: '/usr/bin:/bin' },
      // What `path_helper` built, and what the profile replaced it with.
      loginPaths: async () => [bin],
      shellPath: () => '/opt/homebrew/bin:/usr/bin:/bin'
    })
    expect((await service.status()).onPath).toBeNull()
  })

  it('says nothing claims it when nothing does', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, env: { PATH: '/usr/bin:/bin' } })
    expect((await service.status()).onPath).toBeNull()
  })
})

describe('installing', () => {
  it('links without a password when the directory is writable', async () => {
    const { source, bin } = await scratchApp()
    const { service, escalated } = harness({ source, directory: bin, writable: async () => true })

    const result = await service.install()
    expect(result.outcome).toBe('linked')
    expect(result.administrator).toBe(false)
    expect(escalated).toEqual([])
    expect(await readlink(join(bin, 'teamree'))).toBe(source)
    expect(result.status.state).toBe('linked')
  })

  it('is idempotent: a link that is already right is success, and nothing is written', async () => {
    const { source, bin } = await scratchApp()
    await symlink(source, join(bin, 'teamree'))
    const before = await lstat(join(bin, 'teamree'))
    const { service, escalated } = harness({ source, directory: bin })

    const result = await service.install()
    expect(result.outcome).toBe('already-linked')
    expect(result.administrator).toBe(false)
    expect(escalated).toEqual([])
    expect((await lstat(join(bin, 'teamree'))).ctimeMs).toBe(before.ctimeMs)
  })

  it('replaces a link to a different teamree and says what it replaced', async () => {
    const { source, bin, root } = await scratchApp()
    const older = join(root, 'Downloads', 'teamree.app', 'Contents', 'Resources', 'cli')
    await mkdir(older, { recursive: true })
    await writeFile(join(older, 'teamree'), '#!/bin/sh\n')
    await symlink(join(older, 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const result = await service.install()
    expect(result.outcome).toBe('replaced')
    expect(result.replaced).toBe(join(older, 'teamree'))
    expect(await readlink(join(bin, 'teamree'))).toBe(source)
  })

  it('refuses to delete a regular file and says what is there', async () => {
    const { source, bin } = await scratchApp()
    const occupied = join(bin, 'teamree')
    await writeFile(occupied, 'somebody else’s binary')
    const { service, escalated } = harness({ source, directory: bin })

    await expect(service.install()).rejects.toThrow(/regular file/i)
    await expect(service.install()).rejects.toMatchObject({ code: ErrorCode.Conflict })
    expect(await readFile(occupied, 'utf8')).toBe('somebody else’s binary')
    expect(escalated).toEqual([])
  })

  it('refuses a directory in the way just as flatly', async () => {
    const { source, bin } = await scratchApp()
    await mkdir(join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    await expect(service.install()).rejects.toThrow(/directory/i)
  })
})

describe('when the directory cannot be written', () => {
  it('escalates with a command that survives a space and a double quote in the path', async () => {
    const { source, bin } = await scratchApp()
    const escalated: string[] = []
    const service = new CliService({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      loginPaths: async () => [],
      source,
      directory: bin,
      writable: async () => false,
      // Stands in for osascript by running the same command the real one would
      // hand /bin/sh, so the escaping is executed rather than asserted.
      administrator: async (command) => {
        escalated.push(command)
        await run('/bin/sh', ['-c', command])
      }
    })

    const result = await service.install()
    expect(result.administrator).toBe(true)
    expect(result.outcome).toBe('linked')
    expect(escalated).toHaveLength(1)
    expect(escalated[0]).toBe(`/bin/mkdir -p '${bin}' && /bin/ln -sfn '${source}' '${join(bin, 'teamree')}'`)
    expect(source).toContain('"')
    expect(source).toContain(' ')
    expect(await readlink(join(bin, 'teamree'))).toBe(source)
  })

  it('makes the destination directory, which a fresh Mac does not have', async () => {
    const { source, root } = await scratchApp()
    const missing = join(root, 'usr', 'local', 'bin')
    const escalated: string[] = []
    const service = new CliService({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      loginPaths: async () => [],
      source,
      directory: missing,
      writable: async () => false,
      administrator: async (command) => {
        escalated.push(command)
        await run('/bin/sh', ['-c', command])
      }
    })

    expect((await service.status()).state).toBe('absent')
    const result = await service.install()
    expect(result.outcome).toBe('linked')
    expect(await readlink(join(missing, 'teamree'))).toBe(source)
  })

  it('passes on a refused password without claiming anything happened', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({
      source,
      directory: bin,
      writable: async () => false,
      administrator: async () => {
        throw new RuntimeError(ErrorCode.Conflict, 'The administrator password was not given, so nothing was changed.')
      }
    })

    await expect(service.install()).rejects.toThrow(/password was not given/)
    await expect(lstat(join(bin, 'teamree'))).rejects.toThrow()
  })

  it('does not claim success when the privileged command quietly did nothing', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, writable: async () => false, administrator: async () => {} })

    await expect(service.install()).rejects.toThrow(/does not lead/i)
  })
})

describe('platforms this app cannot do it on', () => {
  it('reports the destination and refuses to touch it', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, platform: 'linux' })

    const status = await service.status()
    expect(status.installable).toBe(false)
    expect(status.platform).toBe('linux')
    expect(status.destination).toBe(join(bin, 'teamree'))

    // The refusal carries the command, because that is the whole of what is
    // left for somebody on a platform this button cannot serve.
    await expect(service.install()).rejects.toThrow(/macOS/)
    await expect(service.install()).rejects.toThrow(new RegExp(`ln -s .*${'teamree'}`))
  })
})

describe('a build with no CLI in it', () => {
  it('says so rather than linking nothing', async () => {
    const { bin } = await scratchApp()
    const { service } = harness({ source: null, directory: bin })

    expect((await service.status()).source).toBeNull()
    await expect(service.install()).rejects.toMatchObject({ code: ErrorCode.NotFound })
  })
})

describe('the question this installation asks once', () => {
  /** Stands in for the workspace store: the same contract, in memory. */
  function record(): { askedAt: () => number | undefined; markAsked: (at: number) => void; seen: number[] } {
    const seen: number[] = []
    return {
      seen,
      askedAt: () => seen[0],
      markAsked: (at) => {
        if (seen.length === 0) seen.push(at)
      }
    }
  }

  it('has not been asked on a fresh installation', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, prompt: record() })
    expect((await service.status()).askedAt).toBeNull()
  })

  it('remembers being declined, and says when', async () => {
    const { source, bin } = await scratchApp()
    const prompt = record()
    const { service } = harness({ source, directory: bin, prompt, now: () => 1700000000000 })

    const after = await service.dismissPrompt()
    expect(after.askedAt).toBe(1700000000000)
    expect(prompt.seen).toEqual([1700000000000])
    expect((await service.status()).askedAt).toBe(1700000000000)
  })

  it('keeps the first answer rather than moving it every time it is declined', async () => {
    const { source, bin } = await scratchApp()
    const prompt = record()
    let clock = 1700000000000
    const { service } = harness({ source, directory: bin, prompt, now: () => clock })

    await service.dismissPrompt()
    clock = 1800000000000
    expect((await service.dismissPrompt()).askedAt).toBe(1700000000000)
  })

  it('counts installing as the answer, so nothing asks again afterwards', async () => {
    const { source, bin } = await scratchApp()
    const prompt = record()
    const { service } = harness({ source, directory: bin, prompt, now: () => 1700000000000 })

    const result = await service.install()
    expect(result.status.askedAt).toBe(1700000000000)
    expect(prompt.seen).toEqual([1700000000000])
  })

  it('does not count a refusal as an answer: there was nothing to answer with', async () => {
    const { source, bin } = await scratchApp()
    const prompt = record()
    await writeFile(join(bin, 'teamree'), 'somebody else’s binary')
    const { service } = harness({ source, directory: bin, prompt })

    await expect(service.install()).rejects.toThrow(/regular file/i)
    expect(prompt.seen).toEqual([])
  })

  it('says whether the CLI it found is inside a packaged app', async () => {
    const { source, bin } = await scratchApp()
    expect((await harness({ source, directory: bin }).service.status()).packaged).toBe(false)
    expect((await harness({ source, directory: bin, packaged: true }).service.status()).packaged).toBe(true)
  })

  it('remembers for this process alone when there is nowhere to write it down', async () => {
    const { source, bin } = await scratchApp()
    const { service } = harness({ source, directory: bin, now: () => 1700000000000 })

    expect((await service.status()).askedAt).toBeNull()
    expect((await service.dismissPrompt()).askedAt).toBe(1700000000000)
  })
})

describe('running from somewhere a link cannot follow', () => {
  /** What the DMG window invites a double-click on, spelled the way macOS spells it. */
  const ON_VOLUME = '/Volumes/teamree 0.1.0/teamree.app/Contents/Resources/cli/teamree'
  /** What macOS runs instead when an app is opened outside /Applications. */
  const TRANSLOCATED =
    '/private/var/folders/9m/2k4n0000gn/T/AppTranslocation/8F2C1A3E-0000-4E2B-9C11-5D6E7F801234/d/' +
    'teamree.app/Contents/Resources/cli/teamree'

  it('names the disk image rather than linking into it', async () => {
    const { bin } = await scratchApp()
    const { service } = harness({ source: ON_VOLUME, directory: bin, packaged: true })

    expect((await service.status()).impermanent).toBe('volume')
  })

  it('names App Translocation, and is not fooled by a directory that merely says so', async () => {
    const { bin } = await scratchApp()
    expect((await harness({ source: TRANSLOCATED, directory: bin }).service.status()).impermanent).toBe('translocated')

    // A folder somebody made called AppTranslocation, outside the per-boot
    // temporary directory macOS actually uses, is a path a link survives.
    const impostor = '/Users/ann/AppTranslocation/teamree.app/Contents/Resources/cli/teamree'
    expect((await harness({ source: impostor, directory: bin }).service.status()).impermanent).toBeNull()
  })

  it('says the app is somewhere ordinary when it is', async () => {
    const { source, bin } = await scratchApp()
    expect((await harness({ source, directory: bin }).service.status()).impermanent).toBeNull()
  })

  it('refuses to link the copy inside the disk image, and says what to do instead', async () => {
    const { bin } = await scratchApp()
    const { service, escalated } = harness({ source: ON_VOLUME, directory: bin, writable: async () => false })

    await expect(service.install()).rejects.toThrow(/Applications/)
    await expect(service.install()).rejects.toThrow(/eject/i)
    await expect(service.install()).rejects.toMatchObject({ code: ErrorCode.Conflict })
    // No password spent on a link that would dangle, and nothing written.
    expect(escalated).toEqual([])
    await expect(lstat(join(bin, 'teamree'))).rejects.toThrow()
  })

  it('refuses the translocated copy too, before it asks for anything', async () => {
    const { bin } = await scratchApp()
    const { service, escalated } = harness({ source: TRANSLOCATED, directory: bin, writable: async () => false })

    await expect(service.install()).rejects.toThrow(/Applications/)
    await expect(service.install()).rejects.toMatchObject({ code: ErrorCode.Conflict })
    expect(escalated).toEqual([])
  })

  it('refuses even when the link already points at the copy on the volume', async () => {
    const { bin } = await scratchApp()
    await symlink(ON_VOLUME, join(bin, 'teamree'))
    const { service } = harness({ source: ON_VOLUME, directory: bin })

    // 'already-linked' would be true of the link and false of the command: the
    // volume is ejected eventually, and then it leads nowhere.
    await expect(service.install()).rejects.toThrow(/Applications/)
  })
})

describe('a link whose app has gone', () => {
  it('says the target is not there, which a link to another copy does not', async () => {
    const { source, bin, root } = await scratchApp()
    await symlink(join(root, 'gone', 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('elsewhere')
    expect(status.dangling).toBe(true)
  })

  it('says nothing of the kind about a link that lands on something', async () => {
    const { source, bin, root } = await scratchApp()
    const older = join(root, 'Downloads', 'teamree.app', 'Contents', 'Resources', 'cli')
    await mkdir(older, { recursive: true })
    await writeFile(join(older, 'teamree'), '#!/bin/sh\n')
    await symlink(join(older, 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const status = await service.status()
    expect(status.state).toBe('elsewhere')
    expect(status.dangling).toBe(false)
  })

  it('is false of everything that is not a link at all', async () => {
    const { source, bin } = await scratchApp()
    expect((await harness({ source, directory: bin }).service.status()).dangling).toBe(false)

    await writeFile(join(bin, 'teamree'), 'somebody else’s binary')
    expect((await harness({ source, directory: bin }).service.status()).dangling).toBe(false)
  })

  it('replaces it and stops calling it dangling afterwards', async () => {
    const { source, bin, root } = await scratchApp()
    await symlink(join(root, 'gone', 'teamree'), join(bin, 'teamree'))
    const { service } = harness({ source, directory: bin })

    const result = await service.install()
    expect(result.outcome).toBe('replaced')
    expect(result.status.dangling).toBe(false)
    expect(await readlink(join(bin, 'teamree'))).toBe(source)
  })
})
