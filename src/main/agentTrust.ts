// Gives a worktree teamree just made the folder trust claude and codex already give its
// project's main checkout, so neither stops at its trust prompt there. Never trusts
// anything else: no main-checkout entry, no write.

import { constants, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** claude's global file: under `CLAUDE_CONFIG_DIR` when set, a legacy `.config.json` first. */
export async function claudeConfigFile(env: Env, home: string): Promise<string> {
  const dir = env.CLAUDE_CONFIG_DIR || undefined
  const legacy = path.join(dir ?? path.join(home, '.claude'), '.config.json')
  if (existsSync(legacy)) return legacy
  return path.join(dir ?? home, `.claude${env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''}.json`)
}

/** codex's user config, under `CODEX_HOME` when set. */
export function codexConfigFile(env: Env, home: string): string {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** True when claude has `projects[folder].hasTrustDialogAccepted` for one of these spellings. */
export function claudeTrusts(text: string, folders: readonly string[]): boolean {
  const projects = parseObject(text)?.projects
  return (
    isObject(projects) &&
    folders.some((folder) => (projects[folder] as Json | undefined)?.hasTrustDialogAccepted === true)
  )
}

// What claude itself writes for a folder it has never seen before it sets the flag.
const CLAUDE_PROJECT_DEFAULTS = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false
}

/** The file with `folder` trusted, 2-space JSON as claude writes it; null when nothing should change. */
export function withClaudeTrust(text: string, folder: string): string | null {
  const config = parseObject(text)
  const projects = config?.projects ?? {}
  if (config === null || !isObject(projects)) return null
  const entry = projects[folder]
  if (entry !== undefined && !isObject(entry)) return null
  if (entry?.hasTrustDialogAccepted === true) return null
  config.projects = { ...projects, [folder]: { ...CLAUDE_PROJECT_DEFAULTS, ...entry, hasTrustDialogAccepted: true } }
  return JSON.stringify(config, null, 2) + (text.endsWith('\n') ? '\n' : '')
}

const PROJECT_TABLE = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/
const TRUSTED_LINE = /^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/

function tableFolder(line: string): string | null {
  const quoted = PROJECT_TABLE.exec(line)?.[1]
  if (quoted === undefined) return null
  if (quoted.startsWith("'")) return quoted.slice(1, -1)
  try {
    return JSON.parse(quoted) as string
  } catch {
    return null
  }
}

/** True when a `[projects."<folder>"]` table says `trust_level = "trusted"`, codex's own spelling. */
export function codexTrusts(text: string, folders: readonly string[]): boolean {
  let folder: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) folder = tableFolder(line)
    else if (folder !== null && folders.includes(folder) && TRUSTED_LINE.test(line)) return true
  }
  return false
}

/** The file with one table appended; null when the folder is named anywhere already or `projects` is inline. */
export function withCodexTrust(text: string, folder: string): string | null {
  const key = JSON.stringify(folder)
  // A second table for the same key, or one extending an inline table, makes the file unreadable to codex.
  if (text.includes(folder) || text.includes(key.slice(1, -1)) || /^\s*projects\s*=/m.test(text)) return null
  const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}[projects.${key}]\ntrust_level = "trusted"\n`
}

/**
 * Read, change, write a temp file beside it, rename over it; read again once if the file moved in
 * between. Keeps `<file>.teamree-backup` from the first write ever. False when nothing was written.
 */
export async function rewriteConfig(file: string, change: (text: string) => string | null): Promise<boolean> {
  const target = await realpath(file)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(target)
    const next = change(await readFile(target, 'utf8'))
    if (next === null) return false
    const mode = before.mode & 0o777
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.teamree-${process.pid}.tmp`)
    await writeFile(temp, next, { mode })
    try {
      await backUpOnce(target, mode)
      const now = await stat(target)
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue
      await rename(temp, target)
      return true
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
  return false
}

async function backUpOnce(file: string, mode: number): Promise<void> {
  const backup = `${file}.teamree-backup`
  try {
    await copyFile(file, backup, constants.COPYFILE_EXCL)
    await chmod(backup, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** claude's own config lock (a directory beside the file); false when it stayed held past `waitMs`. */
async function underClaudeLock(file: string, waitMs: number, work: () => Promise<boolean>): Promise<boolean> {
  const lock = `${file}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}

export type TrustRequest = {
  mainCheckout: string
  worktree: string
  env?: Env
  home?: string
  lockWaitMs?: number
}

/** Trusts `worktree` in each CLI config that already trusts `mainCheckout`; answers with the files written. */
export async function trustNewWorktree(request: TrustRequest): Promise<string[]> {
  const env = request.env ?? process.env
  const home = request.home ?? os.homedir()
  const main = [...new Set([request.mainCheckout, await realpath(request.mainCheckout)])]
  // Both CLIs key trust by the physical path the agent starts in.
  const worktree = await realpath(request.worktree)
  const written: string[] = []

  const claude = await claudeConfigFile(env, home)
  const claudeChange = (text: string): string | null =>
    claudeTrusts(text, main) ? withClaudeTrust(text, worktree) : null
  if (
    existsSync(claude) &&
    (await attempt(claude, () =>
      underClaudeLock(claude, request.lockWaitMs ?? 2000, () => rewriteConfig(claude, claudeChange))
    ))
  ) {
    written.push(claude)
  }

  const codex = codexConfigFile(env, home)
  const codexChange = (text: string): string | null => (codexTrusts(text, main) ? withCodexTrust(text, worktree) : null)
  if (existsSync(codex) && (await attempt(codex, () => rewriteConfig(codex, codexChange)))) written.push(codex)
  return written
}

async function attempt(file: string, write: () => Promise<boolean>): Promise<boolean> {
  try {
    return await write()
  } catch (error) {
    console.warn(`[trust] could not update ${file}`, error)
    return false
  }
}
