// The coordination ledger from a pane: what overlaps this worktree, the paths it
// claims, and the short decisions its siblings should see.

import type { ProjectContext } from '../../shared/memory.js'
import { PANE_IDENTITY_ENV } from '../../shared/tasks.js'
import { readBoolean, readNumber, readString, readStrings } from '../argv.js'
import type { CommandContext, CommandSpec } from '../command-spec.js'
import { HERE, resolveWorktree } from '../selectors.js'

const WORKTREE_FLAG = {
  name: 'worktree',
  kind: 'string',
  placeholder: '<worktree>',
  description: 'Worktree id, name, path, branch, or here (the default).'
} as const

export function contextText(context: ProjectContext, raw: boolean): string {
  if (raw) return context.text
  if (context.text === '') return 'No overlap.'
  const cut = context.truncated.map((row) => `${row.dropped} ${row.section}`)
  return cut.length === 0 ? context.text : `${context.text}\n(cut: ${cut.join(', ')})`
}

async function callerWorktree(context: CommandContext): Promise<string> {
  const caller = { env: context.env, cwd: context.cwd }
  return (await resolveWorktree(context.client, readString(context.flags, 'worktree') ?? HERE, caller)).id
}

export const contextCommands: readonly CommandSpec[] = [
  {
    path: ['context'],
    summary: 'Show what overlaps this worktree: sibling goals, shared paths, conflicts, decisions.',
    details:
      'Empty unless another live worktree touches, claims or decided about the same paths. Conflicts come from ' +
      '`git merge-tree`; lockfiles and files most worktrees touch count for little.',
    flags: [
      WORKTREE_FLAG,
      {
        name: 'budget',
        kind: 'number',
        placeholder: '<tokens>',
        description: 'Token budget, 200 to 4000. Default 500.'
      },
      { name: 'text', kind: 'boolean', description: 'Print the bundle alone, and nothing when nothing overlaps.' }
    ],
    examples: ['teamree context', 'teamree context --worktree fix-login --json', 'teamree context --text --budget 300'],
    run: async (context) => {
      const worktreeId = await callerWorktree(context)
      const budget = readNumber(context.flags, 'budget')
      const raw = readBoolean(context.flags, 'text')
      const result = await context.client.call('project.context', {
        worktreeId,
        ...(budget === undefined ? {} : { budgetTokens: budget }),
        ...(raw ? { format: 'text' as const } : {})
      })
      return { data: result, text: contextText(result, raw) }
    }
  },
  {
    path: ['claim'],
    summary: 'Claim paths for this worktree. Advisory: siblings are told, nothing is locked.',
    args: [
      { name: 'globs', description: 'Repo-relative paths or globs, e.g. src/api/**.', required: true, variadic: true }
    ],
    flags: [WORKTREE_FLAG],
    examples: ['teamree claim src/limiter/** docs/limits.md'],
    run: async (context) => {
      const claims = await context.client.call('memory.claim', {
        worktreeId: await callerWorktree(context),
        globs: [...context.args]
      })
      return { data: claims, text: `claims: ${claims.globs.join(', ')}` }
    }
  },
  {
    path: ['unclaim'],
    summary: 'Drop claims; with no globs, all of them.',
    args: [{ name: 'globs', description: 'Claims to drop.', variadic: true }],
    flags: [WORKTREE_FLAG],
    examples: ['teamree unclaim', 'teamree unclaim docs/limits.md'],
    run: async (context) => {
      const claims = await context.client.call('memory.unclaim', {
        worktreeId: await callerWorktree(context),
        ...(context.args.length === 0 ? {} : { globs: [...context.args] })
      })
      return { data: claims, text: claims.globs.length === 0 ? 'No claims.' : `claims: ${claims.globs.join(', ')}` }
    }
  },
  {
    path: ['note'],
    summary: 'Record a short decision. Siblings see it when they touch its paths; it expires when this worktree lands.',
    args: [{ name: 'text', description: 'The decision, at most 500 characters.', required: true, variadic: true }],
    flags: [
      WORKTREE_FLAG,
      {
        name: 'path',
        kind: 'string',
        placeholder: '<path>',
        repeatable: true,
        description: 'A path or glob it is about. Without one, only this worktree and its children see it.'
      }
    ],
    examples: ['teamree note "Limiter state lives in postgres advisory locks" --path src/limiter/**'],
    run: async (context) => {
      const paths = readStrings(context.flags, 'path')
      const pane = context.env[PANE_IDENTITY_ENV.terminalId]
      const note = await context.client.call('memory.note', {
        worktreeId: await callerWorktree(context),
        kind: 'decision',
        text: context.args.join(' '),
        ...(paths.length === 0 ? {} : { paths }),
        ...(pane ? { terminalId: pane } : {})
      })
      return { data: note, text: `noted ${note.id}` }
    }
  }
]
