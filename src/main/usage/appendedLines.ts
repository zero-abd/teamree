// Reads only what was appended to a transcript since the last read. The agents append whole lines,
// so the offset stops at the last newline and a half-written line is read again next time.

import { open, stat } from 'node:fs/promises'

export type FileMark = { size: number; mtimeMs: number; offset: number }

const CHUNK_BYTES = 1 << 20
const NEWLINE = 0x0a

export function freshMark(): FileMark {
  return { size: -1, mtimeMs: -1, offset: 0 }
}

/**
 * Hands each new line to `visit`. Resolves to 'same' without opening an unchanged file, and to
 * 'restarted' when the file shrank, after reading it again from the start.
 */
export async function readAppended(
  file: string,
  mark: FileMark,
  visit: (line: string) => void
): Promise<'same' | 'read' | 'restarted' | 'gone'> {
  const info = await stat(file).catch(() => null)
  if (info === null) return 'gone'
  if (info.size === mark.size && info.mtimeMs === mark.mtimeMs) return 'same'
  const restarted = info.size < mark.offset
  if (restarted) mark.offset = 0

  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return 'gone'
  try {
    let carry = Buffer.alloc(0)
    let position = mark.offset
    while (position < info.size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      const joined =
        carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      const end = joined.lastIndexOf(NEWLINE)
      if (end === -1) {
        carry = joined
        continue
      }
      for (const line of joined.subarray(0, end).toString('utf8').split('\n')) if (line.length > 0) visit(line)
      mark.offset += end + 1
      carry = joined.subarray(end + 1)
    }
  } finally {
    await handle.close()
  }
  mark.size = info.size
  mark.mtimeMs = info.mtimeMs
  return restarted ? 'restarted' : 'read'
}

export function parsedLine(line: string): Record<string, unknown> | null {
  try {
    return objectOf(JSON.parse(line))
  } catch {
    // A line cut short by a crash mid-write.
    return null
  }
}

export function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
