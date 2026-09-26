// Selectors name a project or worktree by id, name or checkout path. Matching
// is tiered, and a tier that matches more than one thing is an error.

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Project, Worktree } from '../shared/entities.js'
import { PANE_IDENTITY_ENV } from '../shared/tasks.js'
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
 * Canonical form for path comparison. `realpathSync.native` because only it
 * reports the on-disk spelling of a case-insensitive match; resolution climbs
 * to the nearest existing ancestor so a path not on disk yet follows the same symlinks.
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

/** Who is asking, for the `here` selector. */
export type Caller = { env: NodeJS.ProcessEnv; cwd: string }

export const HERE = 'here'

export async function resolveProject(client: RuntimeClient, token: string, caller?: Caller): Promise<Project> {
  const projects = await client.call('project.list', {})
  if (token !== HERE) return selectOne('project', token, projects)
  const at = caller ?? processCaller()
  const named = projects.find((project) => project.id === at.env[PANE_IDENTITY_ENV.projectId])
  if (named !== undefined) return named
  const worktree = enclosing(await client.call('worktree.list', {}), at.cwd)
  const found = projects.find((project) => project.id === worktree?.projectId) ?? enclosing(projects, at.cwd)
  if (found === undefined) throw notHere('project')
  return found
}

function processCaller(): Caller {
  return { env: process.env, cwd: process.cwd() }
}

function notHere(what: string): CliError {
  return new CliError({
    code: 'not_found',
    message: `No ${what} here: not in a teamree pane or checkout.`,
    exitCode: ExitCode.Failure
  })
}

/** The deepest item whose path is `cwd` or a directory above it. */
function enclosing<T extends { path: string }>(items: readonly T[], cwd: string): T | undefined {
  const at = pathComparisonKey(cwd)
  return items
    .map((item) => ({ item, key: pathComparisonKey(item.path) }))
    .filter(({ key }) => at === key || at.startsWith(key.endsWith(sep) ? key : key + sep))
    .sort((a, b) => b.key.length - a.key.length)[0]?.item
}

/** The calling pane's worktree, else the checkout holding `cwd`, subdirectories included. */
export function selectHere(worktrees: readonly Worktree[], caller: Caller): Worktree {
  const fromPane = caller.env[PANE_IDENTITY_ENV.worktreeId]
  const found = worktrees.find((worktree) => worktree.id === fromPane) ?? enclosing(worktrees, caller.cwd)
  if (found === undefined) throw notHere('worktree')
  return found
}

/** A terminal id as given, or the calling pane's for `here`. */
export function terminalSelector(token: string, caller: Caller = processCaller()): string {
  if (token !== HERE) return token
  const id = caller.env[PANE_IDENTITY_ENV.terminalId]
  if (!id) throw notHere('pane')
  return id
}

/** Picks one worktree out of a listing already in hand, so `terminal list` needs no second round trip. */
export function selectWorktree(worktrees: readonly Worktree[], token: string, caller?: Caller): Worktree {
  if (token === HERE) return selectHere(worktrees, caller ?? processCaller())
  return selectOne(
    'worktree',
    token,
    worktrees.map((worktree) => ({ ...worktree, aliases: [worktree.branch] }))
  )
}

export async function resolveWorktree(client: RuntimeClient, token: string, caller?: Caller): Promise<Worktree> {
  return selectWorktree(await client.call('worktree.list', {}), token, caller)
}
