// How the CLI finds a running runtime: one small JSON file at a fixed location
// under the user data dir. It is a hint, not a lock — the CLI must still connect
// and expect failure, because a crashed runtime leaves the file behind.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PROTOCOL_VERSION } from '../../shared/protocol'
import { readJsonFile, writeJsonFileAtomically } from '../store/atomicJsonFile'

export const DISCOVERY_FILE_NAME = 'runtime.json'

const RuntimeDiscoverySchema = z.object({
  endpoint: z.string().min(1),
  pid: z.number().int().positive(),
  version: z.string().min(1),
  protocolVersion: z.number().int(),
  startedAt: z.number()
})

export type RuntimeDiscovery = z.infer<typeof RuntimeDiscoverySchema>

export function discoveryFilePath(userDataDir: string): string {
  return join(userDataDir, DISCOVERY_FILE_NAME)
}

export async function writeDiscoveryFile(
  filePath: string,
  info: Omit<RuntimeDiscovery, 'protocolVersion'>
): Promise<void> {
  await writeJsonFileAtomically(filePath, { ...info, protocolVersion: PROTOCOL_VERSION })
}

/** Undefined when absent, unreadable, or written by an incompatible build. */
export async function readDiscoveryFile(filePath: string): Promise<RuntimeDiscovery | undefined> {
  const parsed = RuntimeDiscoverySchema.safeParse(await readJsonFile(filePath))
  return parsed.success ? parsed.data : undefined
}

export async function removeDiscoveryFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => {})
}
