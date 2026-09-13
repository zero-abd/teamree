// Disk writes here are crash-atomic: a half-written temp file is never visible
// under the real name, because rename(2) is atomic within a filesystem. A user
// who force-quits mid-write loses the newest change, never the whole workspace.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * What was at the path, told apart rather than flattened.
 *
 * A file that was never written and a file that could not be read are
 * different events: the first is how every first launch begins, and the second
 * is somebody's workspace that this process is one write away from destroying.
 * A caller that cannot distinguish them treats both as "start empty".
 */
export type JsonFileRead =
  | { kind: 'missing' }
  | { kind: 'parsed'; value: unknown }
  | { kind: 'unreadable'; reason: string }

export async function openJsonFile(filePath: string): Promise<JsonFileRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', reason: describe(error) }
  }
  try {
    return { kind: 'parsed', value: JSON.parse(raw) as unknown }
  } catch (error) {
    return { kind: 'unreadable', reason: describe(error) }
  }
}

/** Returns undefined for a missing, unreadable, or non-JSON file. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  const read = await openJsonFile(filePath)
  return read.kind === 'parsed' ? read.value : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  await mkdir(dirname(filePath), { recursive: true })

  // The pid and a counter keep concurrent writers from clobbering each other's
  // temp file, which would otherwise produce a torn rename.
  const tempPath = `${filePath}.${process.pid}.${nextTempSuffix()}.tmp`
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

let tempCounter = 0
function nextTempSuffix(): string {
  tempCounter += 1
  return `${Date.now().toString(36)}${tempCounter.toString(36)}`
}
