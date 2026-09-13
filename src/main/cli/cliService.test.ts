// Everything here drives the service through its seams: the destination
// directory is a fresh temporary one and the privileged runner is a function
// this file wrote. Nothing in this suite can reach /usr/local/bin, which is the
// point — an installer whose tests need the real root of the filesystem is an
// installer nobody can change safely.

import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** An app bundle with a CLI in it, at a path awkward enough to be interesting. */
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
  const bin = join(root, 'bin')
  await mkdir(bin)
  return { root, source, bin }
}

type Harness = { service: CliService; escalated: string[] }

function harness(options: Partial<CliServiceOptions> & { directory: string }): Harness {
  const escalated: string[] = []
  const service = new CliService({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    loginPaths: async () => [],
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
