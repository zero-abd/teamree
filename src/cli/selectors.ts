// Selectors let an agent name a project or worktree the way it already knows
// it: by id, by the name it just created it with, or by the checkout path it is
// standing in. Matching is tiered, and a tier that matches more than one thing
// is an error rather than a coin flip.

import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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

/** Canonical form for path comparison; symlinked temp dirs are the usual trap. */
export function canonicalPath(input: string): string {
  const absolute = resolve(input)
  try {
    return existsSync(absolute) ? realpathSync(absolute) : absolute
  } catch {
    return absolute
  }
}

export type SelectorTier = 'id' | 'name' | 'path' | 'id-prefix' | 'alias'

export function selectOne<T extends Selectable>(
  kind: string,
  token: string,
  items: readonly T[]
): T {
  const lower = token.toLowerCase()
  const tokenPath = canonicalPath(token)

  const tiers: ReadonlyArray<[SelectorTier, (item: T) => boolean]> = [
    ['id', (item) => item.id === token],
    ['name', (item) => item.name === token],
    ['name', (item) => item.name.toLowerCase() === lower],
    ['path', (item) => canonicalPath(item.path) === tokenPath],
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
    hint: items.length === 0 ? `No ${kind}s exist yet.` : `Known ${kind}s: ${items.map((item) => item.name).join(', ')}.`,
    data: { known: items.map((item) => ({ id: item.id, name: item.name, path: item.path })) }
  })
}

export async function resolveProject(client: RuntimeClient, token: string): Promise<Project> {
  const projects = await client.call('project.list', {})
  return selectOne('project', token, projects)
}

export async function resolveWorktree(client: RuntimeClient, token: string): Promise<Worktree> {
  const worktrees = await client.call('worktree.list', {})
  const selectable = worktrees.map((worktree) => ({ ...worktree, aliases: [worktree.branch] }))
  return selectOne('worktree', token, selectable)
}
