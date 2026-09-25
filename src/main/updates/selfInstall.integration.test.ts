// The whole in-place update against real tools: a tiny ad-hoc-signed app in a temporary
// "Applications", its next version zipped and served with a manifest from a local server,
// then check → download → verify → unpack → restart → the helper's swap and relaunch.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatestRelease } from './latestRelease'
import { SelfInstaller } from './selfInstaller'
import { UpdateService } from './updateService'

const REPOSITORY = 'owner/project'
const IDENTIFIER = 'us.teamree.updatetest'

let root: string
let server: Server | undefined
let app: ChildProcess | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'teamree-selfinstall-')))
})

afterEach(async () => {
  app?.kill()
  if (server) await new Promise((resolve) => server?.close(resolve))
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

/** An app whose executable writes its version to `<root>/launched`, signed ad hoc. */
function fakeApp(path: string, version: string, identifier = IDENTIFIER): void {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(path, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>fake</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`
  )
  const executable = join(path, 'Contents', 'MacOS', 'fake')
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}' >> '${join(root, 'launched')}'\n`)
  chmodSync(executable, 0o755)
  expect(spawnSync('/usr/bin/codesign', ['-s', '-', '-f', path]).status).toBe(0)
}

function versionOf(path: string): string {
  return spawnSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')],
    {
      encoding: 'utf8'
    }
  ).stdout.trim()
}

type Published = { release: LatestRelease; allowed: (url: string) => boolean }

/** Zips `build/teamree.app`, writes its manifest, and serves both the way a release does. */
async function publish(options: { sha256?: string } = {}): Promise<Published> {
  const serve = join(root, 'serve')
  mkdirSync(serve)
  const zip = join(serve, 'teamree-0.3.0.zip')
  expect(
    spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(root, 'build', 'teamree.app'), zip]).status
  ).toBe(0)
  const bytes = readFileSync(zip)
  const manifest = {
    version: '0.3.0',
    file: 'teamree-0.3.0.zip',
    size: bytes.length,
    sha256: options.sha256 ?? createHash('sha256').update(bytes).digest('hex')
  }
  writeFileSync(join(serve, 'teamree-mac.json'), JSON.stringify(manifest))

  const prefix = `/${REPOSITORY}/releases/download/v0.3.0/`
  server = createServer((request, response) => {
    const name = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : ''
    const file = join(serve, name)
    if (name === '' || name.includes('/') || !existsSync(file)) return void response.writeHead(404).end()
    response.writeHead(200).end(readFileSync(file))
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const asset = (name: string) => ({
    name,
    url: `${origin}${prefix}${name}`,
    size: statSync(join(serve, name)).size,
    sha256: null
  })

  return {
    release: {
      version: '0.3.0',
      tag: 'v0.3.0',
      prerelease: false,
      notes: null,
      downloadUrl: null,
      installer: null,
      releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v0.3.0`,
      publishedAt: null,
      assets: [asset('teamree-mac.json'), asset('teamree-0.3.0.zip')]
    },
    allowed: (url) => new URL(url).origin === origin
  }
}

/** Stands in for `open`: runs the bundle's executable directly, so nothing is registered with Launch Services. */
function opener(): string {
  const path = join(root, 'open')
  writeFileSync(path, '#!/bin/sh\nfor last; do :; done\nexec "$last/Contents/MacOS/fake"\n')
  chmodSync(path, 0o755)
  return path
}

function service(published: Published) {
  app = spawn('/bin/sleep', ['60'])
  const restarts: number[] = []
  const problems: string[] = []
  const update = new UpdateService({
    version: '0.2.0',
    repository: REPOSITORY,
    settings: {
      read: () => ({ automatic: true, lastCheckedAt: null, lastSeenVersion: null }),
      setAutomatic: () => {},
      recordAttempt: () => {},
      rememberLatest: () => {}
    },
    readRelease: async () => published.release,
    allowDownload: published.allowed,
    selfInstall: new SelfInstaller({
      bundlePath: join(root, 'Applications', 'teamree.app'),
      stagingRoot: join(root, 'userData', 'updates'),
      pid: app.pid as number,
      opener: opener()
    }),
    restart: () => restarts.push(1),
    onProblem: (message) => problems.push(message)
  })
  return { update, restarts, problems }
}

describe.runIf(process.platform === 'darwin')('updating in place', () => {
  it('downloads, verifies and stages the new copy, then swaps it in once the app has quit and opens it', async () => {
    const applications = join(root, 'Applications')
    fakeApp(join(applications, 'teamree.app'), '0.2.0')
    fakeApp(join(root, 'build', 'teamree.app'), '0.3.0')
    const { update, restarts } = service(await publish())

    await update.check({ force: true, person: true })
    await vi.waitFor(() => expect(update.state().install).toEqual({ state: 'ready', version: '0.3.0' }), {
      timeout: 30_000
    })
    await update.restartToUpdate()
    expect(restarts).toHaveLength(1)

    update.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(versionOf(join(applications, 'teamree.app'))).toBe('0.2.0')

    app?.kill()
    // The helper logs `installed` last, after removing the previous copy; `launched` comes before that.
    const log = join(root, 'userData', 'updates', 'update.log')
    await vi.waitFor(() => expect(existsSync(log) && readFileSync(log, 'utf8')).toMatch(/installed 0\.3\.0/), {
      timeout: 30_000
    })
    expect(readFileSync(join(root, 'launched'), 'utf8')).toBe('0.3.0\n')
    expect(readdirSync(applications)).toEqual(['teamree.app'])
    expect(versionOf(join(applications, 'teamree.app'))).toBe('0.3.0')
    expect(
      spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(applications, 'teamree.app')]).status
    ).toBe(0)
    const flagged = spawnSync('/usr/bin/xattr', ['-r', join(applications, 'teamree.app')], { encoding: 'utf8' })
    expect(flagged.stdout).not.toContain('com.apple.quarantine')
    expect(existsSync(join(root, 'userData', 'updates', '0.3.0'))).toBe(false)
  })

  it('refuses a zip whose checksum the manifest does not promise, and keeps nothing', async () => {
    fakeApp(join(root, 'Applications', 'teamree.app'), '0.2.0')
    fakeApp(join(root, 'build', 'teamree.app'), '0.3.0')
    const { update } = service(await publish({ sha256: '0'.repeat(64) }))

    await update.check({ force: true })
    await vi.waitFor(() => expect(update.state().install?.state).toBe('failed'), { timeout: 30_000 })
    expect(update.state().install).toMatchObject({ problem: expect.stringMatching(/checksum/) })
    expect(readdirSync(join(root, 'userData', 'updates'))).toEqual([])
    await expect(update.restartToUpdate()).rejects.toThrow(/no update ready/)
  })

  it('refuses another app, or one whose signature no longer verifies', async () => {
    for (const spoil of ['identifier', 'signature'] as const) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root)
      fakeApp(join(root, 'Applications', 'teamree.app'), '0.2.0')
      fakeApp(join(root, 'build', 'teamree.app'), '0.3.0', spoil === 'identifier' ? 'com.example.other' : IDENTIFIER)
      if (spoil === 'signature')
        writeFileSync(join(root, 'build', 'teamree.app', 'Contents', 'MacOS', 'fake'), '#!/bin/sh\n')
      const { update } = service(await publish())

      await update.check({ force: true })
      await vi.waitFor(() => expect(update.state().install?.state).toBe('failed'), { timeout: 30_000 })
      expect(update.state().install, spoil).toMatchObject({ problem: expect.stringContaining(spoil) })
      expect(versionOf(join(root, 'Applications', 'teamree.app'))).toBe('0.2.0')
      app?.kill()
      await new Promise((resolve) => server?.close(resolve))
      server = undefined
    }
  })
})
