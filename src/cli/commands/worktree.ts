import type { CommandSpec } from '../command-spec.js'
import { readBoolean, readNumber, readString, requireString } from '../argv.js'
import { formatFields, formatTable } from '../output.js'
import { resolveProject, resolveWorktree } from '../selectors.js'
import { DEFAULT_WAIT_TIMEOUT_MS, waitForState } from '../waiting.js'
import { CliError } from '../exit.js'

export const worktreeCommands: readonly CommandSpec[] = [
  {
    path: ['worktree', 'list'],
    summary: 'List worktrees, optionally for one project.',
    flags: [
      {
        name: 'project',
        kind: 'string',
        placeholder: '<project>',
        description: 'Restrict to one project (id, name, or path).'
      }
    ],
    examples: ['teamree worktree list --json', 'teamree worktree list --project api'],
    run: async (context) => {
      const selector = readString(context.flags, 'project')
      const projectId = selector === undefined ? undefined : (await resolveProject(context.client, selector)).id
      const worktrees = await context.client.call('worktree.list', projectId === undefined ? {} : { projectId })
      return {
        data: worktrees,
        text: formatTable(
          ['ID', 'NAME', 'BRANCH', 'STATE', 'PATH'],
          worktrees.map((worktree) => [worktree.id, worktree.name, worktree.branch, worktree.state, worktree.path]),
          'No worktrees. Create one with: teamree worktree create --project <id> --name <name>'
        )
      }
    }
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a worktree and its branch.',
    details: 'Returns as soon as the runtime accepts the request; the row may still be in the "creating" state.',
    flags: [
      {
        name: 'project',
        kind: 'string',
        placeholder: '<project>',
        description: 'Project id, name, or path.',
        required: true
      },
      {
        name: 'name',
        kind: 'string',
        placeholder: '<name>',
        description: 'Task name; also seeds the branch name.',
        required: true
      },
      {
        name: 'from',
        kind: 'string',
        placeholder: '<ref>',
        description: "Ref or sha to branch from; defaults to the project's base ref."
      },
      {
        name: 'branch',
        kind: 'string',
        placeholder: '<branch>',
        description: 'Explicit branch name instead of one derived from --name.'
      }
    ],
    examples: ['teamree worktree create --project api --name fix-login --from origin/main'],
    run: async (context) => {
      const project = await resolveProject(context.client, requireString(context.flags, 'project'))
      const startedFrom = readString(context.flags, 'from')
      const branch = readString(context.flags, 'branch')
      const worktree = await context.client.call('worktree.create', {
        projectId: project.id,
        name: requireString(context.flags, 'name'),
        ...(startedFrom === undefined ? {} : { startedFrom }),
        ...(branch === undefined ? {} : { branch })
      })
      return {
        data: worktree,
        text: formatFields([
          ['id', worktree.id],
          ['name', worktree.name],
          ['branch', worktree.branch],
          ['from', worktree.startedFrom],
          ['state', worktree.state],
          ['path', worktree.path]
        ])
      }
    }
  },
  {
    path: ['worktree', 'remove'],
    summary: 'Remove a worktree checkout.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      { name: 'force', kind: 'boolean', description: 'Remove even with uncommitted changes or unmerged commits.' },
      { name: 'delete-branch', kind: 'boolean', description: 'Delete the branch alongside the checkout.' }
    ],
    examples: ['teamree worktree remove fix-login --force --delete-branch'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      await context.client.call('worktree.remove', {
        worktreeId: worktree.id,
        force: readBoolean(context.flags, 'force'),
        deleteBranch: readBoolean(context.flags, 'delete-branch')
      })
      return { data: { removed: true, worktree }, text: `removed worktree ${worktree.name} (${worktree.id})` }
    }
  },
  {
    path: ['worktree', 'status'],
    summary: 'Show live git status for one worktree.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const status = await context.client.call('worktree.status', { worktreeId: worktree.id })
      return {
        data: status,
        text: formatFields([
          ['worktree', `${worktree.name} (${status.worktreeId})`],
          ['branch', status.branch],
          ['ahead/behind', `${status.ahead}/${status.behind}`],
          ['staged', String(status.staged)],
          ['unstaged', String(status.unstaged)],
          ['untracked', String(status.untracked)],
          ['conflicted', String(status.conflicted)],
          ['read at', new Date(status.readAt).toISOString()]
        ])
      }
    }
  },
  {
    path: ['worktree', 'changes'],
    summary: 'List the changed paths in a worktree.',
    details:
      'The counters in `worktree status` say whether there is anything to look at. This is the looking: ' +
      'conflicts first, then what is staged, then the rest.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'limit',
        kind: 'number',
        placeholder: '<count>',
        description: 'Rows to return before the list reports itself truncated.'
      }
    ],
    examples: ['teamree worktree changes fix-login', 'teamree worktree changes fix-login --json'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const limit = readNumber(context.flags, 'limit')
      const result = await context.client.call('worktree.changes', {
        worktreeId: worktree.id,
        ...(limit === undefined ? {} : { limit })
      })

      const rows = result.changes.map((change) => [
        change.kind,
        change.staged ? (change.unstaged ? 'both' : 'staged') : 'unstaged',
        change.from === undefined ? change.path : `${change.from} -> ${change.path}`
      ])
      const table = formatTable(['KIND', 'WHERE', 'PATH'], rows, 'No changes.')
      return {
        data: result,
        text: result.truncated ? `${table}\n\nShowing ${result.limit} of ${result.total}.` : table
      }
    }
  },
  {
    path: ['worktree', 'diff'],
    summary: 'Print the patch for a worktree, or for one path in it.',
    details:
      'Untracked files are included when a path names one, since git itself has nothing to compare them ' +
      'against and would otherwise answer with silence.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      { name: 'path', kind: 'string', placeholder: '<path>', description: 'Restrict the patch to one path.' },
      { name: 'staged', kind: 'boolean', description: 'Diff the index against HEAD instead of the working tree.' },
      { name: 'context', kind: 'number', placeholder: '<lines>', description: 'Context lines around each hunk.' },
      {
        name: 'max-bytes',
        kind: 'number',
        placeholder: '<bytes>',
        description: 'Ceiling on the patch returned. It is cut at a line boundary.'
      }
    ],
    examples: [
      'teamree worktree diff fix-login',
      'teamree worktree diff fix-login --path src/app.ts',
      'teamree worktree diff fix-login --staged'
    ],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const patchPath = readString(context.flags, 'path')
      const staged = readBoolean(context.flags, 'staged')
      const contextLines = readNumber(context.flags, 'context')
      const maxBytes = readNumber(context.flags, 'max-bytes')

      const result = await context.client.call('worktree.diff', {
        worktreeId: worktree.id,
        ...(patchPath === undefined ? {} : { path: patchPath }),
        ...(staged ? { staged: true } : {}),
        ...(contextLines === undefined ? {} : { contextLines }),
        ...(maxBytes === undefined ? {} : { maxBytes })
      })

      // The patch goes out as git wrote it, so it can be piped into `git apply`
      // or read by anything that understands a unified diff.
      const text = result.patch === '' ? 'No changes.' : result.patch
      return { data: result, text: result.truncated ? `${text}\n[cut at ${result.patch.length} characters]` : text }
    }
  },
  {
    path: ['worktree', 'wait'],
    summary: 'Block until a worktree finishes being created.',
    details:
      'Creation runs in the background, so `worktree create` answers immediately with state "creating". ' +
      'This waits for it to settle, and exits non-zero if it settled as failed.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'for',
        kind: 'string',
        placeholder: '<state>',
        choices: ['ready', 'settled'],
        description: 'Wait for ready, or for any settled state. Defaults to ready.'
      },
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Give up after this long. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`
      }
    ],
    examples: ['teamree worktree create --project app --name fix-login --json && teamree worktree wait fix-login'],
    run: async (context) => {
      const selector = context.args[0] as string
      const target = await resolveWorktree(context.client, selector)
      const want = readString(context.flags, 'for') ?? 'ready'

      const settled = await waitForState({
        client: context.client,
        what: `worktree ${target.name}`,
        read: async () => {
          const rows = await context.client.call('worktree.list', {})
          return rows.find((row) => row.id === target.id)
        },
        settled: (row) => row === undefined || row.state === 'ready' || row.state === 'failed',
        timeoutMs: readNumber(context.flags, 'timeout-ms') ?? DEFAULT_WAIT_TIMEOUT_MS
      })

      if (settled === undefined) {
        throw new CliError({
          code: 'worktree_gone',
          message: `Worktree ${selector} disappeared while waiting.`,
          exitCode: 1
        })
      }
      if (want === 'ready' && settled.state !== 'ready') {
        throw new CliError({
          code: 'worktree_failed',
          message: `Worktree ${settled.name} settled as ${settled.state}: ${settled.error ?? 'no reason given'}`,
          exitCode: 1,
          data: settled
        })
      }

      return {
        data: settled,
        text: formatFields([
          ['name', settled.name],
          ['branch', settled.branch],
          ['state', settled.state],
          ['path', settled.path]
        ])
      }
    }
  }
]
