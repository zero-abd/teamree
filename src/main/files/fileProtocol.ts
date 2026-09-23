// `teamree-file://` serves images, PDFs and media that `worktree.readFile`
// granted. A URL names a grant, never a path, so the renderer cannot ask for
// a file the runtime did not already confine.

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

export const FILE_SCHEME = 'teamree-file'

/** For `protocol.registerSchemesAsPrivileged`; `stream` is what lets a video seek. */
export const FILE_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true } as const

export type FileGrant = { root: string; absolute: string; mime: string }

const GRANT_HOST = 'grant'

export class FileGrants {
  readonly #byToken = new Map<string, FileGrant>()
  readonly #byPath = new Map<string, string>()

  constructor(
    private readonly limit = 256,
    private readonly token: () => string = randomUUID
  ) {}

  /** A URL for `grant`; `version` changes it when the file does, so nothing caches a stale copy. */
  grant(grant: FileGrant, version: number): string {
    let token = this.#byPath.get(grant.absolute)
    if (token === undefined) {
      token = this.token()
      this.#byPath.set(grant.absolute, token)
    }
    this.#byToken.delete(token)
    this.#byToken.set(token, grant)
    while (this.#byToken.size > this.limit) {
      const [oldest, dropped] = this.#byToken.entries().next().value as [string, FileGrant]
      this.#byToken.delete(oldest)
      this.#byPath.delete(dropped.absolute)
    }
    const name = encodeURIComponent(path.basename(grant.absolute))
    return `${FILE_SCHEME}://${GRANT_HOST}/${token}/${name}?v=${Math.round(version)}`
  }

  lookup(url: string): FileGrant | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== `${FILE_SCHEME}:` || parsed.hostname !== GRANT_HOST) return null
    const token = parsed.pathname.split('/')[1] ?? ''
    return this.#byToken.get(token) ?? null
  }
}

/** The one table the runtime and the protocol handler share. */
export const fileGrants = new FileGrants()

/** The byte range a `Range` header asks for, clamped to the file, or null for the whole file. */
export function byteRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return null
  if (from === '') {
    const suffix = Number(to)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/** Answers one request against the grants, re-checking the file is still inside its worktree. */
export async function serveGrantedFile(
  grants: FileGrants,
  request: { url: string; headers: Headers }
): Promise<Response> {
  const grant = grants.lookup(request.url)
  if (grant === null) return new Response(null, { status: 404 })

  let size: number
  let real: string
  try {
    real = await realpath(grant.absolute)
    const inside = path.relative(await realpath(grant.root), real)
    if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      return new Response(null, { status: 403 })
    }
    const info = await stat(real)
    if (!info.isFile()) return new Response(null, { status: 404 })
    size = info.size
  } catch {
    return new Response(null, { status: 404 })
  }

  const headers = new Headers({
    'Content-Type': grant.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  // An SVG is a document that can run script when framed on its own.
  if (grant.mime === 'image/svg+xml')
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")

  const range = byteRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (range !== null) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const body =
    size === 0
      ? null
      : (Readable.toWeb(createReadStream(real, { start, end })) as unknown as ReadableStream<Uint8Array>)
  return new Response(body, { status: range === null ? 200 : 206, headers })
}
