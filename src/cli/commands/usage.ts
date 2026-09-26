// `worktree usage`: tokens each worktree's agents spent, read from their own transcripts.

import type { Worktree } from '../../shared/entities.js'
import type { WorktreeUsage } from '../../shared/tasks.js'
import { usageLabel } from '../../shared/usage.js'
import { readString } from '../argv.js'
import type { CommandSpec } from '../command-spec.js'
import { formatTable } from '../output.js'
import { resolveProject, resolveWorktree } from '../selectors.js'
import { treeRows } from './worktree.js'

/** A row per worktree in tree order; the WITH CHILDREN column only when a parent is listed. */
export function usageText(worktrees: readonly Worktree[], usage: readonly WorktreeUsage[], showCost: boolean): string {
  const byId = new Map(usage.map((each) => [each.worktreeId, each]))
  const listed = worktrees.filter((worktree) => byId.has(worktree.id))
  const rolled = usage.some((each) => each.subtree !== undefined)
  const rows = treeRows(listed).map(({ worktree, depth }) => {
    const read = byId.get(worktree.id)
    const own = read === undefined ? null : usageLabel(read, showCost)
    const subtree = read?.subtree === undefined ? '' : (usageLabel(read.subtree, showCost) ?? '-')
    return [`${'  '.repeat(depth)}${worktree.name}`, own ?? '-', ...(rolled ? [subtree] : [])]
  })
  return formatTable(['NAME', 'TOKENS', ...(rolled ? ['WITH CHILDREN'] : [])], rows, 'No worktrees.')
}

export const usageCommands: readonly CommandSpec[] = [
  {
    path: ['worktree', 'usage'],
    summary: "Tokens each worktree's agents spent, from Claude Code and Codex transcripts.",
    details:
      'Counts input, output and cache tokens in the transcripts had in each checkout. A parent also shows ' +
      'its total with every child under it. ≈$ appears when Settings › Show Cost is on; --json always has it. ' +
      '≥ marks a worktree with agent panes whose transcripts cannot be read.',
    args: [
      { name: 'worktree', description: 'Worktree id, name, path, branch, or here. Default: all.', required: false }
    ],
    flags: [
      {
        name: 'project',
        kind: 'string',
        placeholder: '<project>',
        description: 'Restrict to one project (id, name, or path).'
      }
    ],
    examples: ['teamree worktree usage', 'teamree worktree usage here', 'teamree worktree usage --project api --json'],
    run: async (context) => {
      const caller = { env: context.env, cwd: context.cwd }
      const selector = context.args[0]
      const project = readString(context.flags, 'project')
      const query =
        selector !== undefined
          ? { worktreeId: (await resolveWorktree(context.client, selector, caller)).id }
          : project !== undefined
            ? { projectId: (await resolveProject(context.client, project, caller)).id }
            : {}
      const [usage, worktrees, settings] = await Promise.all([
        context.client.call('worktree.usage', query),
        context.client.call('worktree.list', {}),
        context.client.call('settings.get', {}).catch(() => null)
      ])
      return { data: usage, text: usageText(worktrees, usage, settings?.showCost ?? false) }
    }
  }
]
