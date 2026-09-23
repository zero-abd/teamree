// One file of a worktree for a file pane. Confined by real path, so a symlink
// may point anywhere inside the checkout and nowhere outside it.

import { chmod, lstat, mkdir, open, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileWritten } from '../../shared/entities'
import { fileViewerFor, MAX_FILE_PANE_BYTES, mediaTypeFor } from '../../shared/filePane'
import { ErrorCode } from '../../shared/protocol'
import { resolveInsideWorktree } from '../git/worktreeFiles'
import { RuntimeError } from '../runtime/runtimeError'
import { fileGrants, type FileGrant } from './fileProtocol'

export type FileReadOptions = {
  worktreeId: string
  worktreePath: string
  path: string
  maxBytes?: number
  /** Answer media, binary and oversize files with a `view` instead of refusing them. */
  viewer?: boolean
  /** Mints the URL a media file is loaded from. */
  grant?: (grant: FileGrant, version: number) => string
}

export type FileWriteOptions = {
  worktreeId: string
  worktreePath: string
  path: string
  content: string
  maxBytes?: number
  encoding?: 'utf-8' | 'utf-8-bom'
  expectedModifiedAt?: number
}

/** How much of a file is inspected for a NUL byte before it is called binary. */
const BINARY_PROBE_BYTES = 8_192

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export async function readWorktreeFile(options: FileReadOptions): Promise<FileContent> {
  const target = resolveFile(options.worktreePath, options.path)
  const maxBytes = options.maxBytes ?? MAX_FILE_PANE_BYTES
  if ((await lstat(target.absolute).catch(() => null)) === null) {
    return { worktreeId: options.worktreeId, path: target.relative, content: '', exists: false, modifiedAt: 0, size: 0 }
  }
  const root = await realpath(options.worktreePath)
  const real = await realpath(target.absolute).catch(() => {
    throw invalid(`"${target.relative}" is a broken link`)
  })
  if (!isInside(root, real)) throw invalid(`"${target.relative}" leads outside the worktree`)
  const info = await stat(real)
  if (!info.isFile()) throw invalid(`"${target.relative}" is not a file`)
  const base = {
    worktreeId: options.worktreeId,
    path: target.relative,
    content: '',
    exists: true,
    modifiedAt: info.mtimeMs,
    size: info.size
  }

  const mime = options.viewer ? mediaTypeFor(target.relative) : null
  if (mime !== null) {
    const viewer = fileViewerFor(target.relative)
    const kind = viewer === 'image' || viewer === 'pdf' ? viewer : 'media'
    const grant = options.grant ?? ((granted, version) => fileGrants.grant(granted, version))
    return { ...base, view: { kind, mime, url: grant({ root, absolute: real, mime }, info.mtimeMs) } }
  }
  if (info.size > maxBytes) {
    if (options.viewer) return { ...base, view: { kind: 'tooLarge', limit: maxBytes } }
    throw tooLarge(target.relative, maxBytes)
  }

  const text = decodeText(await readCapped(real, maxBytes))
  if (text === null) {
    if (options.viewer) return { ...base, view: { kind: 'binary' } }
    throw new RuntimeError(ErrorCode.BadRequest, `"${target.relative}" is not a text file`)
  }
  return {
    ...base,
    content: text.text,
    encoding: text.bom ? 'utf-8-bom' : 'utf-8',
    lineEnding: text.text.includes('\r\n') ? '\r\n' : '\n'
  }
}

export async function writeWorktreeFile(options: FileWriteOptions): Promise<FileWritten> {
  const target = resolveFile(options.worktreePath, options.path)
  const maxBytes = options.maxBytes ?? MAX_FILE_PANE_BYTES
  const body = Buffer.from(options.content, 'utf8')
  const bytes = options.encoding === 'utf-8-bom' ? Buffer.concat([UTF8_BOM, body]) : body
  if (bytes.byteLength > maxBytes) throw tooLarge(target.relative, maxBytes)

  const root = await realpath(options.worktreePath)
  const real = await realTarget(target.absolute, target.relative)
  if (!isInside(root, real)) throw invalid(`"${target.relative}" leads outside the worktree`)
  const existing = await stat(real).catch(() => null)
  if (existing !== null && !existing.isFile()) throw invalid(`"${target.relative}" is not a file`)
  if (options.expectedModifiedAt !== undefined && (existing?.mtimeMs ?? 0) !== options.expectedModifiedAt) {
    throw new RuntimeError(ErrorCode.Conflict, `"${target.relative}" changed on disk`)
  }

  await mkdir(path.dirname(real), { recursive: true })
  // Renamed over so a crash leaves the old file whole; the watcher ignores a trailing `~`.
  const temporary = `${real}.${process.pid}.tmp~`
  await writeFile(temporary, bytes)
  if (existing !== null) await chmod(temporary, existing.mode & 0o7777)
  await rename(temporary, real)
  const written = await stat(real)
  return { worktreeId: options.worktreeId, path: target.relative, modifiedAt: written.mtimeMs, size: written.size }
}

/** UTF-8 text with its BOM taken off, or null when the bytes are not text. */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes)
    return { text, bom }
  } catch {
    return null
  }
}

async function readCapped(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    return buffer.subarray(0, Math.min(bytesRead, limit))
  } finally {
    await handle.close()
  }
}

/** Where a write lands: the file's real path, or its nearest real ancestor plus the rest. */
async function realTarget(absolute: string, relative: string): Promise<string> {
  if ((await lstat(absolute).catch(() => null)) !== null) {
    return realpath(absolute).catch(() => {
      throw invalid(`"${relative}" is a broken link`)
    })
  }
  let ancestor = path.dirname(absolute)
  const rest = [path.basename(absolute)]
  for (;;) {
    const real = await realpath(ancestor).catch(() => null)
    if (real !== null) return path.join(real, ...rest)
    rest.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
}

function isInside(root: string, real: string): boolean {
  const inside = path.relative(root, real)
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)
}

function resolveFile(worktreePath: string, relative: string): { absolute: string; relative: string } {
  const target = resolveInsideWorktree(worktreePath, relative)
  if (target === null || target.relative === '') throw invalid(`"${relative}" is not a file inside the worktree`)
  return target
}

function invalid(message: string): RuntimeError {
  return new RuntimeError(ErrorCode.InvalidParams, message)
}

function tooLarge(relative: string, maxBytes: number): RuntimeError {
  return new RuntimeError(ErrorCode.BadRequest, `"${relative}" is larger than ${maxBytes} bytes`)
}
