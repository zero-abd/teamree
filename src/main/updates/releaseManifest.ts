// `teamree-mac.json`, published with each release by scripts/release.mjs: which zip holds the
// app, and its size and SHA-256. Without one that matches the release exactly, nothing installs.

import { z } from 'zod'
import { fetchAllowed, type HostPolicy } from './downloadInstaller'
import { readBounded, type DiskImage, type ReleaseAsset } from './latestRelease'
import { parseVersion } from './semver'

export const MANIFEST_NAME = 'teamree-mac.json'

/** A manifest is a few dozen bytes. */
const MAX_MANIFEST_BYTES = 16 * 1024

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

/** Fetches and parses a manifest; null when the body is not one. Throws when it could not be fetched. */
export async function readManifest(options: {
  url: string
  allowed: HostPolicy
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<ReleaseManifest | null> {
  const response = await fetchAllowed(options.url, options.allowed, options.fetchImpl, options.signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`the manifest answered ${response.status}`)
  }
  return parseManifest(await readBounded(response, MAX_MANIFEST_BYTES))
}
