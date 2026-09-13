import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IDENTITY_FILE_NAME, loadIdentity, PRIVATE_KEY_MODE } from './identity'
import { isPublicKey } from './memberFile'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-identity-'))
  dirs.push(dir)
  return dir
}

describe('the keypair for this installation', () => {
  it('generates a key the roster can carry', async () => {
    const identity = await loadIdentity(await dataDir())

    expect(isPublicKey(identity.publicKey)).toBe(true)
  })

  it('is the same identity on every later run, so the roster stays true', async () => {
    const dir = await dataDir()

    const first = await loadIdentity(dir)
    const second = await loadIdentity(dir)

    expect(second.publicKey).toBe(first.publicKey)
  })

  it('settles on one key when two runtimes start at once', async () => {
    const dir = await dataDir()

    const identities = await Promise.all(Array.from({ length: 8 }, () => loadIdentity(dir)))

    expect(new Set(identities.map((identity) => identity.publicKey)).size).toBe(1)
  })

  it('keeps the private half readable by nobody but its owner', async () => {
    const dir = await dataDir()

    const identity = await loadIdentity(dir)

    expect(identity.privateKeyPath).toBe(path.join(dir, IDENTITY_FILE_NAME))
    // Windows has no POSIX mode to check; what protects the file there is the
    // ACL on the app's data directory, which is not this module's to set.
    if (process.platform !== 'win32') {
      const mode = (await stat(identity.privateKeyPath)).mode & 0o777
      expect(mode).toBe(PRIVATE_KEY_MODE)
    }
  })

  it('tightens a key that came back from a backup world-readable', async () => {
    if (process.platform === 'win32') return
    const dir = await dataDir()
    const identity = await loadIdentity(dir)
    await chmod(identity.privateKeyPath, 0o644)

    await loadIdentity(dir)

    expect((await stat(identity.privateKeyPath)).mode & 0o777).toBe(PRIVATE_KEY_MODE)
  })

  it('refuses a damaged identity by name, without quoting what it found', async () => {
    const dir = await dataDir()
    const file = path.join(dir, IDENTITY_FILE_NAME)
    await writeFile(file, 'SUPER-SECRET-LOOKING-GARBAGE\n', 'utf8')

    const failure = await loadIdentity(dir).then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toContain(file)
    expect(failure?.message).not.toContain('SUPER-SECRET-LOOKING-GARBAGE')
  })

  it('never hands the private key back to a caller that only asked who it is', async () => {
    const dir = await dataDir()

    const identity = await loadIdentity(dir)

    const stored = await readFile(identity.privateKeyPath, 'utf8')
    expect(JSON.stringify(identity)).not.toContain(secretOf(stored))
    expect(Object.values(identity)).not.toContain(stored)
  })
})

/** The base64 body of a PEM private key: the bytes that must never travel. */
function secretOf(pem: string): string {
  return pem
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('')
}
