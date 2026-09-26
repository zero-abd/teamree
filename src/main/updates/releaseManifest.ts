// `teamree-mac.json`, published and signed with the owner's key by scripts/release.mjs: which zip
// holds the app, and its size and SHA-256. Unsigned, or not matching the release exactly, nothing installs.

import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import { fetchAllowed, type HostPolicy } from './downloadInstaller'
import { readBounded, type DiskImage, type LatestRelease, type ReleaseAsset } from './latestRelease'
import { compareVersions, parseVersion } from './semver'

export const MANIFEST_NAME = 'teamree-mac.json'

/** The base64 ed25519 signature over the manifest's exact bytes. */
export const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`

/** A manifest is a few dozen bytes. */
const MAX_MANIFEST_BYTES = 16 * 1024

const MAX_SIGNATURE_BYTES = 1024

/** An installer bigger than this is not one this project built. */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

export type ReleaseManifest = { version: string; file: string; size: number; sha256: string }

const ManifestSchema = z.object({
  version: z.string().refine((value) => parseVersion(value) !== null && !value.startsWith('v')),
  file: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.zip$/),
  size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
})

export function parseManifest(text: string): ReleaseManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) return null
  const { version, file, size, sha256 } = parsed.data
  return { version, file, size, sha256 }
}

/** The zip the manifest promises, or null when the release disagrees with it anywhere. */
export function promisedArchive(
  manifest: ReleaseManifest,
  release: { version: string; assets?: readonly ReleaseAsset[] | undefined }
): DiskImage | null {
  if (manifest.version !== release.version) return null
  const asset = release.assets?.find((candidate) => candidate.name === manifest.file)
  if (asset === undefined || asset.size !== manifest.size) return null
  if (asset.sha256 !== null && asset.sha256 !== manifest.sha256) return null
  return { url: asset.url, name: asset.name, size: manifest.size, sha256: manifest.sha256 }
}

/** A release the app does not act on at all: not signed by a trusted key, or not the version it claims. */
export class UntrustedRelease extends Error {}

/** Whether one of `keys` (ed25519, SPKI PEM) signed exactly `bytes`; `signature` is base64. */
export function signatureVerifies(bytes: Uint8Array, signature: string, keys: readonly string[]): boolean {
  const raw = Buffer.from(signature.trim(), 'base64')
  if (raw.length !== 64) return false
  return keys.some((pem) => {
    try {
      const key = createPublicKey(pem)
      return key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, raw)
    } catch {
      return false
    }
  })
}

/**
 * The release's manifest once its signature verifies, its version is the tag's and newer than `current`.
 * Throws `UntrustedRelease` otherwise, before anything the manifest names is fetched.
 */
export async function trustedManifest(
  release: Pick<LatestRelease, 'tag' | 'assets'>,
  options: {
    current: string
    keys: readonly string[]
    allowed: HostPolicy
    fetchImpl?: typeof fetch
    signal?: AbortSignal
  }
): Promise<ReleaseManifest> {
  const listed = release.assets?.find((asset) => asset.name === MANIFEST_NAME)
  const signed = release.assets?.find((asset) => asset.name === SIGNATURE_NAME)
  if (listed === undefined) throw new UntrustedRelease(`the release has no ${MANIFEST_NAME}`)
  if (signed === undefined) throw new UntrustedRelease(`the release has no ${SIGNATURE_NAME}`)
  const text = await fetchText(listed.url, MAX_MANIFEST_BYTES, options)
  const signature = await fetchText(signed.url, MAX_SIGNATURE_BYTES, options)
  // Re-encoding can only change bytes the owner never signed, so a lossy decode fails here rather than passing.
  if (!signatureVerifies(Buffer.from(text, 'utf8'), signature, options.keys)) {
    throw new UntrustedRelease(`${MANIFEST_NAME} is not signed by a trusted key`)
  }
  const manifest = parseManifest(text)
  if (manifest === null) throw new Error(`${MANIFEST_NAME} is not a manifest`)
  if (manifest.version !== release.tag.replace(/^v/, '')) {
    throw new UntrustedRelease(`${MANIFEST_NAME} is for ${manifest.version}, not ${release.tag}`)
  }
  const version = parseVersion(manifest.version)
  const current = parseVersion(options.current)
  if (version === null || current === null || compareVersions(version, current) <= 0) {
    throw new UntrustedRelease(`${manifest.version} is not newer than ${options.current}`)
  }
  return manifest
}

async function fetchText(
  url: string,
  limit: number,
  options: { allowed: HostPolicy; fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<string> {
  const response = await fetchAllowed(url, options.allowed, options.fetchImpl, options.signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${url.slice(url.lastIndexOf('/') + 1)} answered ${response.status}`)
  }
  return readBounded(response, limit)
}
