// Fetching a release's disk image into a directory. Every hop is checked
// against a host policy, and the file only takes its real name once its size
// and SHA-256 match what GitHub published; anything else leaves nothing behind.

import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isReleaseDownload, RELEASE_HOST, type DiskImage } from './latestRelease'

/** GitHub answers a download with one redirect to its storage; more is a loop. */
export const MAX_REDIRECTS = 5

/** No bytes for this long is a dead connection, not a slow one. */
export const STALL_TIMEOUT_MS = 30_000

/** Whether a URL may be fetched; `redirected` is false only for the release's own link. */
export type HostPolicy = (url: string, redirected: boolean) => boolean

export class ChecksumMismatch extends Error {
  constructor() {
    super('checksum mismatch')
  }
}

export type DownloadOptions = {
  image: DiskImage
  directory: string
  allowed: HostPolicy
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (received: number) => void
}

/** The real hosts: this repository's release links, then GitHub's asset storage over TLS. */
export function releaseHostPolicy(repository: string): HostPolicy {
  return (candidate, redirected) => {
    if (!redirected) return isReleaseDownload(candidate, repository)
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      return false
    }
    return (
      url.protocol === 'https:' && (url.hostname === RELEASE_HOST || url.hostname.endsWith('.githubusercontent.com'))
    )
  }
}

/** Downloads and verifies the image; resolves to where it was saved. */
export async function downloadDiskImage(options: DownloadOptions): Promise<string> {
  const { image, directory, allowed, onProgress } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const stall = new AbortController()
  const signal = options.signal === undefined ? stall.signal : AbortSignal.any([options.signal, stall.signal])
  let stallTimer = setTimeout(() => stall.abort(new Error('the download stalled')), STALL_TIMEOUT_MS)
  const keepAlive = (): void => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stall.abort(new Error('the download stalled')), STALL_TIMEOUT_MS)
  }

  const target = join(directory, image.name)
  const partial = `${target}.download`
  try {
    let url = image.url
    let response: Response
    for (let hop = 0; ; hop++) {
      if (!allowed(url, hop > 0)) throw new Error(`refused ${hostOf(url)}`)
      // Manual, so each hop passes the policy before it is requested.
      response = await fetchImpl(url, { redirect: 'manual', signal })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || location === null) break
      await response.body?.cancel()
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects')
      url = new URL(location, url).href
    }
    if (!response.ok || response.body === null) throw new Error(`the download answered ${response.status}`)

    const hash = createHash('sha256')
    let received = 0
    const file = await open(partial, 'w')
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        received += chunk.byteLength
        if (received > image.size) throw new Error('size mismatch')
        hash.update(chunk)
        await file.write(chunk)
        keepAlive()
        onProgress?.(received)
      }
    } finally {
      await reader.cancel().catch(() => {})
      await file.close()
    }
    if (received !== image.size) throw new Error('size mismatch')
    if (hash.digest('hex') !== image.sha256) throw new ChecksumMismatch()
    await rename(partial, target)
    return target
  } catch (error) {
    await rm(partial, { force: true })
    throw stall.signal.aborted ? stall.signal.reason : error
  } finally {
    clearTimeout(stallTimer)
  }
}

function hostOf(candidate: string): string {
  try {
    return new URL(candidate).host
  } catch {
    return 'an address that does not parse'
  }
}
