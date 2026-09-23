// Fetching a disk image against a local server: a real socket and real bytes,
// so the redirect handling, the size budget and the hash are the real ones.

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChecksumMismatch, downloadDiskImage, releaseHostPolicy } from './downloadInstaller'
import type { DiskImage } from './latestRelease'

const BYTES = Buffer.alloc(300_000, 7)
const SHA = createHash('sha256').update(BYTES).digest('hex')

let server: Server
let origin: string
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'teamree-installer-'))
  server = createServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(302, { location: '/image.dmg' }).end()
    } else if (request.url === '/away') {
      response.writeHead(302, { location: 'http://example.invalid/image.dmg' }).end()
    } else if (request.url === '/image.dmg') {
      response.writeHead(200, { 'content-length': BYTES.length }).end(BYTES)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
})

function image(overrides: Partial<DiskImage> = {}): DiskImage {
  return { url: `${origin}/image.dmg`, name: 'teamree-0.2.0.dmg', size: BYTES.length, sha256: SHA, ...overrides }
}

/** The test's stand-in for the release hosts: this server, and nothing else. */
const local = (url: string): boolean => new URL(url).origin === origin

describe('downloading the installer', () => {
  it('saves it under its own name once size and SHA-256 match, and reports progress', async () => {
    const progress: number[] = []
    const saved = await downloadDiskImage({
      image: image(),
      directory,
      allowed: local,
      onProgress: (n) => progress.push(n)
    })

    expect(saved).toBe(join(directory, 'teamree-0.2.0.dmg'))
    expect((await readFile(saved)).equals(BYTES)).toBe(true)
    expect(progress.at(-1)).toBe(BYTES.length)
    expect(await readdir(directory)).toEqual(['teamree-0.2.0.dmg'])
  })

  it('follows a redirect the policy allows', async () => {
    const saved = await downloadDiskImage({ image: image({ url: `${origin}/moved` }), directory, allowed: local })
    expect((await readFile(saved)).length).toBe(BYTES.length)
  })

  it('refuses a host the policy does not allow, before or after a redirect', async () => {
    await expect(downloadDiskImage({ image: image(), directory, allowed: () => false })).rejects.toThrow(/refused/)
    await expect(
      downloadDiskImage({ image: image({ url: `${origin}/away` }), directory, allowed: local })
    ).rejects.toThrow(/refused example\.invalid/)
    expect(await readdir(directory)).toEqual([])
  })

  it('deletes the file when the checksum does not match', async () => {
    const wrong = downloadDiskImage({ image: image({ sha256: '0'.repeat(64) }), directory, allowed: local })
    await expect(wrong).rejects.toBeInstanceOf(ChecksumMismatch)
    expect(await readdir(directory)).toEqual([])
  })

  it('abandons a body longer or shorter than the release says, and keeps nothing', async () => {
    await expect(
      downloadDiskImage({ image: image({ size: BYTES.length - 1 }), directory, allowed: local })
    ).rejects.toThrow(/size/)
    await expect(
      downloadDiskImage({ image: image({ size: BYTES.length + 1 }), directory, allowed: local })
    ).rejects.toThrow(/size/)
    expect(await readdir(directory)).toEqual([])
  })

  it('says what the server answered when it was not the file', async () => {
    await expect(
      downloadDiskImage({ image: image({ url: `${origin}/missing` }), directory, allowed: local })
    ).rejects.toThrow(/404/)
  })
})

describe('the hosts a real download may touch', () => {
  const allowed = releaseHostPolicy('owner/project')

  it('starts only at a release download in the repository', () => {
    expect(allowed('https://github.com/owner/project/releases/download/v0.2.0/x.dmg', false)).toBe(true)
    expect(allowed('https://github.com/other/project/releases/download/v0.2.0/x.dmg', false)).toBe(false)
    expect(allowed('https://release-assets.githubusercontent.com/x', false)).toBe(false)
  })

  it('follows GitHub to its asset storage over TLS, and nowhere else', () => {
    expect(allowed('https://release-assets.githubusercontent.com/x', true)).toBe(true)
    expect(allowed('https://objects.githubusercontent.com/x', true)).toBe(true)
    expect(allowed('http://release-assets.githubusercontent.com/x', true)).toBe(false)
    expect(allowed('https://githubusercontent.com.example.invalid/x', true)).toBe(false)
    expect(allowed('https://example.invalid/x', true)).toBe(false)
  })
})
