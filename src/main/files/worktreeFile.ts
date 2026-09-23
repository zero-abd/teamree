// One text file of a worktree for a file pane: kept inside the checkout, never
// through a symlink, text only and capped, since the editor draws all of it.

import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileWritten } from '../../shared/entities'
import { MAX_FILE_PANE_BYTES } from '../../shared/filePane'
import { ErrorCode } from '../../shared/protocol'
import { resolveInsideWorktree } from '../git/worktreeFiles'
import { RuntimeError } from '../runtime/runtimeError'

export type FileReadOptions = {
  worktreeId: string
  worktreePath: string
  path: string
  maxBytes?: number
}

export type FileWriteOptions = FileReadOptions & { content: string }

/** How much of a file is inspected for a NUL byte before it is called binary. */
const BINARY_PROBE_BYTES = 8_192

export async function readWorktreeFile(options: FileReadOptions): Promise<FileContent> {
  const target = resolveFile(options.worktreePath, options.path)
  const maxBytes = options.maxBytes ?? MAX_FILE_PANE_BYTES
  const stat = await lstat(target.absolute).catch(() => null)
  if (stat === null) {
    return { worktreeId: options.worktreeId, path: target.relative, content: '', exists: false, modifiedAt: 0, size: 0 }
  }
  if (stat.isSymbolicLink()) throw invalid(`"${target.relative}" is a symlink`)
  if (!stat.isFile()) throw invalid(`"${target.relative}" is not a file`)
  if (stat.size > maxBytes) throw tooLarge(target.relative, maxBytes)

  const bytes = await readFile(target.absolute)
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    throw new RuntimeError(ErrorCode.BadRequest, `"${target.relative}" is not a text file`)
  }
  return {
    worktreeId: options.worktreeId,
    path: target.relative,
    content: bytes.toString('utf8'),
    exists: true,
    modifiedAt: stat.mtimeMs,
    size: stat.size
  }
}

export async function writeWorktreeFile(options: FileWriteOptions): Promise<FileWritten> {
  const target = resolveFile(options.worktreePath, options.path)
  const maxBytes = options.maxBytes ?? MAX_FILE_PANE_BYTES
  const bytes = Buffer.from(options.content, 'utf8')
  if (bytes.byteLength > maxBytes) throw tooLarge(target.relative, maxBytes)

  const existing = await lstat(target.absolute).catch(() => null)
  if (existing?.isSymbolicLink()) throw invalid(`"${target.relative}" is a symlink`)
  if (existing !== null && !existing.isFile()) throw invalid(`"${target.relative}" is not a file`)

  await mkdir(path.dirname(target.absolute), { recursive: true })
  // Renamed over so a crash leaves the old file whole; the watcher ignores a trailing `~`.
  const temporary = `${target.absolute}.${process.pid}.tmp~`
  await writeFile(temporary, bytes)
  await rename(temporary, target.absolute)
  const stat = await lstat(target.absolute)
  return { worktreeId: options.worktreeId, path: target.relative, modifiedAt: stat.mtimeMs, size: stat.size }
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
