// Finding the running runtime. The app writes a small JSON file into its
// Electron user data directory; we read it, sanity-check it, and refuse to dial
// an endpoint whose owning process is already gone — a dead unix socket would
// otherwise hang or fail with a cryptic errno.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { CliError, ExitCode, NoRuntimeError } from './exit.js'

/** Matches Electron's `app.getPath('userData')`, which uses the app name. */
export const APP_DIR_NAME = 'teamree'

/** The name the runtime writes; TEAMREE_RUNTIME_FILE overrides the whole path. */
export const DISCOVERY_FILE_NAME = 'runtime.json'

/**
 * Deliberately loose: only the three fields the CLI needs to dial the runtime
 * are required, so a runtime that adds fields never breaks an older CLI.
 */
export const DiscoveryRecordSchema = z.object({
  /** Unix socket path, or a named pipe on Windows. */
  endpoint: z.string().min(1),
  pid: z.number().int().positive(),
  version: z.string().min(1),
  protocolVersion: z.number().int().optional(),
  startedAt: z.number().optional()
})

export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>

export type DiscoveryHost = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** Returns undefined when the file does not exist. */
  readFile: (path: string) => string | undefined
  pathExists: (path: string) => boolean
  isProcessAlive: (pid: number) => boolean
}

export type DiscoveryFailure = {
  ok: false
  reason: 'missing' | 'malformed' | 'stale'
  message: string
  checked: string[]
}

export type DiscoverySuccess = {
  ok: true
  endpoint: string
  /** Where the endpoint came from: a file path, or an environment variable. */
  source: string
  record: DiscoveryRecord | null
}

export type DiscoveryOutcome = DiscoverySuccess | DiscoveryFailure

export function defaultDiscoveryHost(): DiscoveryHost {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    pathExists: (path) => existsSync(path),
    isProcessAlive
  }
}

/** Signal 0 probes without delivering: EPERM still means the pid is taken. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The per-OS directory Electron hands the app for its own state. */
export function userDataDir(host: Pick<DiscoveryHost, 'platform' | 'env' | 'home'>): string {
  const { join } = host.platform === 'win32' ? win32 : posix
  const override = host.env['TEAMREE_USER_DATA_DIR']
  if (override) return override
  if (host.platform === 'darwin') return join(host.home, 'Library', 'Application Support', APP_DIR_NAME)
  if (host.platform === 'win32') {
    const roaming = host.env['APPDATA'] ?? join(host.home, 'AppData', 'Roaming')
    return join(roaming, APP_DIR_NAME)
  }
  return join(host.env['XDG_CONFIG_HOME'] ?? join(host.home, '.config'), APP_DIR_NAME)
}

export function discoveryPath(host: Pick<DiscoveryHost, 'platform' | 'env' | 'home'>): string {
  const { join } = host.platform === 'win32' ? win32 : posix
  return host.env['TEAMREE_RUNTIME_FILE'] ?? join(userDataDir(host), DISCOVERY_FILE_NAME)
}

/** Named pipes live in the kernel, so they can never be stat'd for staleness. */
export function isPipe(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\')
}

/** Parses one discovery file's text. Never throws; malformed input is a result. */
export function parseDiscoveryRecord(
  text: string
): { ok: true; record: DiscoveryRecord } | { ok: false; message: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `not valid JSON (${(error as Error).message})` }
  }
  const parsed = DiscoveryRecordSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'record'
    return { ok: false, message: `${where}: ${issue?.message ?? 'invalid discovery record'}` }
  }
  return { ok: true, record: parsed.data }
}

/**
 * A record is stale when its process is gone, or when the unix socket it names
 * has been removed — a crashed runtime leaves the file behind, and connecting to
 * a dead socket fails far less legibly than saying so.
 */
export function isStale(record: DiscoveryRecord, host: DiscoveryHost): string | null {
  if (!host.isProcessAlive(record.pid)) return `process ${record.pid} is no longer running`
  if (!isPipe(record.endpoint) && host.platform !== 'win32' && !host.pathExists(record.endpoint)) {
    return `socket ${record.endpoint} no longer exists`
  }
  return null
}

/** Locates the runtime, distinguishing "never started" from "died badly". */
export function findRuntime(host: DiscoveryHost = defaultDiscoveryHost()): DiscoveryOutcome {
  const forced = host.env['TEAMREE_ENDPOINT']
  if (forced) return { ok: true, endpoint: forced, source: 'TEAMREE_ENDPOINT', record: null }

  const path = discoveryPath(host)
  const checked = [path]

  const text = host.readFile(path)
  if (text === undefined) return { ok: false, reason: 'missing', message: `no discovery file at ${path}`, checked }

  const parsed = parseDiscoveryRecord(text)
  if (!parsed.ok) return { ok: false, reason: 'malformed', message: `${path}: ${parsed.message}`, checked }

  const stale = isStale(parsed.record, host)
  if (stale) return { ok: false, reason: 'stale', message: `${path}: ${stale}`, checked }

  return { ok: true, endpoint: parsed.record.endpoint, source: path, record: parsed.record }
}

const START_HINT =
  'Start the teamree desktop app (npm run dev in the repo, or launch the installed app), then retry. Set TEAMREE_ENDPOINT to point at a socket directly.'

/** Discovery, but throwing the exit-code-3 error the CLI reports to the caller. */
export function requireRuntime(host: DiscoveryHost = defaultDiscoveryHost()): DiscoverySuccess {
  const outcome = findRuntime(host)
  if (outcome.ok) {
    const spoken = outcome.record?.protocolVersion
    // A running but incompatible runtime is a different problem from an absent
    // one, so it must not look like exit code 3.
    if (spoken !== undefined && spoken !== PROTOCOL_VERSION) {
      throw new CliError({
        code: 'protocol_mismatch',
        message: `The runtime speaks protocol ${spoken}; this CLI speaks ${PROTOCOL_VERSION}.`,
        exitCode: ExitCode.Failure,
        hint: 'Update whichever of the app and the CLI is older.'
      })
    }
    return outcome
  }

  const headline =
    outcome.reason === 'stale'
      ? `The teamree runtime is not running; its discovery file is stale (${outcome.message}).`
      : outcome.reason === 'malformed'
        ? `The teamree discovery file is unreadable (${outcome.message}).`
        : 'The teamree runtime is not running (no discovery file found).'

  throw new NoRuntimeError(headline, START_HINT, { reason: outcome.reason, checked: outcome.checked })
}
