// Selectors let an agent name a project or worktree the way it already knows
// it: by id, by the name it just created it with, or by the checkout path it is
// standing in. Matching is tiered, and a tier that matches more than one thing
// is an error rather than a coin flip.

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Project, Worktree } from '../shared/entities.js'
import { CliError, ExitCode } from './exit.js'
import type { RuntimeClient } from './transport.js'

export type Selectable = {
  id: string
  name: string
  path: string
  /** Extra exact-match keys tried last, e.g. a worktree's branch. */
  aliases?: readonly string[]
}

/** Windows and macOS match filenames case-insensitively; Linux does not. */
const CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Canonical form for path comparison; symlinked temp dirs are the usual trap.
 * `realpathSync.native` rather than the JS implementation because only the
 * former reports the on-disk spelling of a case-insensitive match, and the
 * resolution climbs to the nearest existing ancestor so a path that is not on
 * disk yet still passes through the same symlinks as one that is.
 */
export function canonicalPath(input: string): string {
  const absolute = resolve(input)
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const resolved = realpathSync.native(current)
      return missing.length === 0 ? resolved : join(resolved, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Comparison key for a path token, folded the way this filesystem matches. */
export function pathComparisonKey(input: string): string {
  const canonical = canonicalPath(input)
  return CASE_INSENSITIVE_FILESYSTEM ? canonical.toLowerCase() : canonical
}

export type SelectorTier = 'id' | 'name' | 'path' | 'id-prefix' | 'alias'

export function selectOne<T extends Selectable>(kind: string, token: string, items: readonly T[]): T {
  const lower = token.toLowerCase()
  const tokenPath = pathComparisonKey(token)

  const tiers: ReadonlyArray<[SelectorTier, (item: T) => boolean]> = [
    ['id', (item) => item.id === token],
    ['name', (item) => item.name === token],
    ['name', (item) => item.name.toLowerCase() === lower],
    ['path', (item) => pathComparisonKey(item.path) === tokenPath],
    ['id-prefix', (item) => item.id.startsWith(token)],
    ['alias', (item) => (item.aliases ?? []).some((alias) => alias === token)]
  ]

  for (const [tier, predicate] of tiers) {
    const matches = items.filter(predicate)
    if (matches.length === 1) return matches[0] as T
    if (matches.length > 1) {
      throw new CliError({
        code: 'ambiguous_selector',
        message: `"${token}" matches ${matches.length} ${kind}s by ${tier}. Use an id instead.`,
        exitCode: ExitCode.Failure,
        data: { matches: matches.map((item) => ({ id: item.id, name: item.name, path: item.path })) }
      })
    }
  }

  throw new CliError({
    code: 'not_found',
    message: `No ${kind} matches "${token}".`,
    exitCode: ExitCode.Failure,
    hint:
      items.length === 0
        ? `No ${kind}s exist yet.`
        : // Quoted because a name may hold spaces ("fix login codex"), and a
          // comma-separated list of those cannot be read back apart.
          `Known ${kind}s: ${items.map((item) => JSON.stringify(item.name)).join(', ')}.`,
    data: { known: items.map((item) => ({ id: item.id, name: item.name, path: item.path })) }
  })
}

export async function resolveProject(client: RuntimeClient, token: string): Promise<Project> {
  const projects = await client.call('project.list', {})
  return selectOne('project', token, projects)
}

/**
 * Picks one worktree out of a listing already in hand.
 *
 * Split out from `resolveWorktree` for the caller that needs the whole listing
 * anyway — `terminal list` prints a worktree's name, which means reading the
 * names — so naming one does not cost a second round trip to read the same
 * rows.
 */
export function selectWorktree(worktrees: readonly Worktree[], token: string): Worktree {
  return selectOne(
    'worktree',
    token,
    worktrees.map((worktree) => ({ ...worktree, aliases: [worktree.branch] }))
  )
}

export async function resolveWorktree(client: RuntimeClient, token: string): Promise<Worktree> {
  return selectWorktree(await client.call('worktree.list', {}), token)
}
