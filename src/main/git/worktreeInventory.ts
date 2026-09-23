// What git itself believes about a repository's worktrees. The service's records
// are a cache of this, so every list/get pass reconciles against it.

import type { GitRunner } from './gitProcess'

export type InventoryEntry = {
  path: string
  head?: string
  /** Short branch name, absent when the worktree is detached. */
  branch?: string
  bare: boolean
  detached: boolean
  locked: boolean
}

/** Records are blank-line separated, `key value` or a bare keyword. `-z` landed in git 2.36, above our floor. */
export function parseWorktreeList(raw: string): InventoryEntry[] {
  const entries: InventoryEntry[] = []
  let current: InventoryEntry | null = null

  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed) {
      if (current) entries.push(current)
      current = null
      continue
    }
    const separator = trimmed.indexOf(' ')
    const key = separator === -1 ? trimmed : trimmed.slice(0, separator)
    const value = separator === -1 ? '' : trimmed.slice(separator + 1)

    if (key === 'worktree') {
      if (current) entries.push(current)
      current = { path: unquotePath(value), bare: false, detached: false, locked: false }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = shortenBranch(value)
    else if (key === 'bare') current.bare = true
    else if (key === 'detached') current.detached = true
    else if (key === 'locked') current.locked = true
  }
  if (current) entries.push(current)
  return entries
}

function shortenBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** git C-quotes paths containing control characters or a double quote. */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  const body = value.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === '\\' || next === '"') out += next
    else if (next && next >= '0' && next <= '7') {
      const octal = body.slice(i, i + 3)
      out += String.fromCharCode(Number.parseInt(octal, 8))
      i += 2
    } else if (next !== undefined) out += next
  }
  return out
}

export async function readWorktreeInventory(runner: GitRunner, root: string): Promise<InventoryEntry[]> {
  const { stdout } = await runner.run({
    args: ['worktree', 'list', '--porcelain'],
    cwd: root,
    readOnly: true,
    timeoutMs: 30_000
  })
  return parseWorktreeList(stdout)
}
