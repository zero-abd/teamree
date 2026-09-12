// Disk writes here are crash-atomic: a half-written temp file is never visible
// under the real name, because rename(2) is atomic within a filesystem. A user
// who force-quits mid-write loses the newest change, never the whole workspace.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Returns undefined for a missing, unreadable, or non-JSON file. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch {
    return undefined
  }
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
