// `[Image #N]` in a Claude Code pane, as the file Claude Code wrote when it was pasted:
// `<tmp>/claude-<uid>/<cwd slug>/<session>/images/<N>.<ext>`. See docs/plans/pasted-image-preview.md.

import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parsePsTable } from '../resources/psTable'

/** What the window gets for a placeholder: a grant URL to draw and the path to reveal. */
export type PastedImage = { url: string; path: string }

/** A pane as far as this file needs it. */
export type PastedImagePane = { pid?: number; pinnedSessionId?: string }

export type PastedImageDeps = {
  pane: (terminalId: string) => PastedImagePane | undefined
  /** The text of `ps -axo pid,ppid,pcpu,rss,comm`; empty where there is none. */
  ps: () => Promise<string>
  grant: (file: { root: string; absolute: string; mime: string }, version: number) => string
  readText?: (file: string) => Promise<string>
  list?: (directory: string) => Promise<string[]>
  mtime?: (file: string) => Promise<number | null>
  env?: NodeJS.ProcessEnv
  home?: string
  uid?: number | null
  now?: () => number
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A `ps` table is a spawn; a hover asks once per row crossed. */
const PS_FRESH_MS = 1_500

/** Claude Code's per-user temp root; null where it keeps none this file knows. */
export function claudeTempRoot(env: NodeJS.ProcessEnv, uid: number | null): string | null {
  if (uid === null) return null
  const base = env.CLAUDE_CODE_TMPDIR?.trim() || '/tmp'
  return path.join(base, `claude-${uid}`)
}

/** `pid` and every process under it, nearest first. */
export function descendants(pid: number, table: readonly { pid: number; ppid: number }[]): number[] {
  const found = [pid]
  for (let at = 0; at < found.length; at++) {
    for (const row of table) if (row.ppid === found[at] && !found.includes(row.pid)) found.push(row.pid)
  }
  return found
}

/** The session id in Claude Code's `sessions/<pid>.json`, when it is that pid's. */
export function sessionOfPidFile(text: string, pid: number): string | null {
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; sessionId?: unknown }
    if (parsed.pid !== pid || typeof parsed.sessionId !== 'string') return null
    return SESSION_ID.test(parsed.sessionId) ? parsed.sessionId : null
  } catch {
    return null
  }
}

/** The file named `<index>.<image ext>` in a listing, with its mime type. */
export function imageFileFor(index: number, names: readonly string[]): { name: string; mime: string } | null {
  for (const name of names) {
    const match = /^(\d+)\.([a-z]+)$/.exec(name)
    const mime = match?.[2] === undefined ? undefined : MIME[match[2]]
    if (match !== null && Number(match[1]) === index && mime !== undefined) return { name, mime }
  }
  return null
}

export function createPastedImageFinder(
  deps: PastedImageDeps
): (terminalId: string, index: number) => Promise<PastedImage | null> {
  const readText = deps.readText ?? ((file: string) => readFile(file, 'utf8'))
  const list = deps.list ?? ((directory: string) => readdir(directory))
  const mtime = deps.mtime ?? ((file: string) => stat(file).then((info) => (info.isFile() ? info.mtimeMs : null)))
  const env = deps.env ?? process.env
  const home = deps.home ?? os.homedir()
  const uid = deps.uid === undefined ? (process.platform === 'win32' ? null : (process.getuid?.() ?? null)) : deps.uid
  const now = deps.now ?? Date.now
  const sessionsDir = path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), 'sessions')
  // The session a pane was last seen on, for scrollback left after its Claude Code exited.
  const lastSeen = new Map<string, string>()
  let table: { at: number; rows: Promise<{ pid: number; ppid: number }[]> } | null = null

  const psRows = (): Promise<{ pid: number; ppid: number }[]> => {
    if (table === null || now() - table.at > PS_FRESH_MS) {
      table = { at: now(), rows: deps.ps().then(parsePsTable, () => []) }
    }
    return table.rows
  }

  const liveSession = async (pid: number): Promise<string | null> => {
    for (const candidate of descendants(pid, await psRows())) {
      const text = await readText(path.join(sessionsDir, `${candidate}.json`)).catch(() => null)
      const session = text === null ? null : sessionOfPidFile(text, candidate)
      if (session !== null) return session
    }
    return null
  }

  const imagesDirectory = async (root: string, session: string): Promise<string | null> => {
    for (const slug of await list(root).catch(() => [])) {
      const directory = path.join(root, slug, session, 'images')
      if ((await list(directory).catch(() => null)) !== null) return directory
    }
    return null
  }

  return async (terminalId, index) => {
    const root = claudeTempRoot(env, uid)
    const pane = deps.pane(terminalId)
    if (root === null || pane === undefined) return null
    const live = pane.pid === undefined ? null : await liveSession(pane.pid)
    if (live !== null) lastSeen.set(terminalId, live)
    const session = live ?? lastSeen.get(terminalId) ?? pane.pinnedSessionId
    if (session === undefined || !SESSION_ID.test(session)) return null
    const directory = await imagesDirectory(root, session)
    if (directory === null) return null
    const file = imageFileFor(index, await list(directory).catch(() => []))
    if (file === null) return null
    const absolute = path.join(directory, file.name)
    const version = await mtime(absolute).catch(() => null)
    if (version === null) return null
    return { url: deps.grant({ root: directory, absolute, mime: file.mime }, version), path: absolute }
  }
}
