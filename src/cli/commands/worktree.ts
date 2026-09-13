import type { PaneNode } from '../../shared/entities.js'
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
    path: ['worktree', 'commit'],
    summary: 'Commit staged work in a worktree.',
    details:
      'Nothing is staged for you beyond the paths you name. With no --path, it commits what is already ' +
      'staged and refuses if that is nothing — there is deliberately no "commit everything", because a ' +
      'sweep picks up the one file you did not mean to keep.',
    args: [
      { name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true },
      {
        name: 'path',
        description: 'Stage these before committing. Put them after `--` so none is read as a flag.',
        required: false,
        variadic: true
      }
    ],
    flags: [{ name: 'message', kind: 'string', alias: 'm', placeholder: '<text>', description: 'The commit message.' }],
    examples: [
      'teamree worktree commit fix-login -m "tighten the retry"',
      'teamree worktree commit fix-login -m "only this" -- src/app.ts src/app.test.ts'
    ],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const message = requireString(context.flags, 'message')
      const paths = context.args.slice(1)

      const result = await context.client.call('worktree.commit', {
        worktreeId: worktree.id,
        message,
        ...(paths.length === 0 ? {} : { paths })
      })

      return {
        data: result,
        text: formatFields([
          ['commit', result.shortSha],
          ['message', result.message],
          ['files', String(result.paths.length)],
          ...result.paths.map((path): [string, string] => ['', path])
        ])
      }
    }
  },
  {
    path: ['worktree', 'push'],
    summary: "Send a worktree's branch to its remote.",
    details:
      'Sets the upstream on the first push. There is deliberately no force: the value of one is overwriting ' +
      "somebody else's history. Uncommitted work is reported, not blocked — but what lands is then not what " +
      'is in the worktree.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      { name: 'remote', kind: 'string', placeholder: '<name>', description: 'Where to push. Defaults to origin.' }
    ],
    examples: ['teamree worktree push fix-login', 'teamree worktree push fix-login --remote upstream'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const remote = readString(context.flags, 'remote')
      const result = await context.client.call('worktree.push', {
        worktreeId: worktree.id,
        ...(remote === undefined ? {} : { remote })
      })

      const lines = [
        result.alreadyUpToDate
          ? `${result.remote} already had ${result.branch}.`
          : `Pushed ${result.branch} to ${result.remote}.`
      ]
      if (result.setUpstream) lines.push(`${result.branch} now tracks ${result.upstream}.`)
      if (result.uncommitted > 0) {
        lines.push(`${result.uncommitted} uncommitted change${result.uncommitted === 1 ? '' : 's'} stayed behind.`)
      }
      return { data: result, text: lines.join('\n') }
    }
  },
  {
    path: ['worktree', 'log'],
    summary: 'List the commits a worktree has made that its base has not.',
    details:
      'Scoped to base..branch, because the question is what this worktree did rather than what is in the ' +
      'repository. Newest first.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      { name: 'limit', kind: 'number', placeholder: '<count>', description: 'Commits before the list is capped.' }
    ],
    examples: ['teamree worktree log fix-login', 'teamree worktree log fix-login --limit 5 --json'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const limit = readNumber(context.flags, 'limit')
      const log = await context.client.call('worktree.log', {
        worktreeId: worktree.id,
        ...(limit === undefined ? {} : { limit })
      })

      const table = formatTable(
        ['COMMIT', 'WHEN', 'AUTHOR', 'SUBJECT'],
        log.commits.map((commit) => [
          commit.shortSha,
          commit.committedAt.slice(0, 10),
          commit.author,
          commit.subject.split('\n')[0] ?? ''
        ]),
        `Nothing committed here that ${log.baseRef} does not already have.`
      )
      return { data: log, text: log.truncated ? `${table}\n\nCapped; there are more.` : table }
    }
  },
  {
    path: ['worktree', 'merges'],
    summary: 'Say whether a worktree would merge cleanly into its base.',
    details:
      'Answered without checking anything out or starting a merge, so it costs the repository nothing and ' +
      'can be asked about every worktree at once. The answer is in `state` under --json: clean, conflicts, ' +
      'unrelated, or unavailable.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    examples: ['teamree worktree merges fix-login', 'teamree worktree merges fix-login --json'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const preview = await context.client.call('worktree.mergePreview', { worktreeId: worktree.id })

      const summary = {
        nothingToMerge: `${worktree.branch} has nothing ${preview.baseRef} does not already have.`,
        clean: `${worktree.branch} merges cleanly into ${preview.baseRef}.`,
        conflicts: `${worktree.branch} conflicts with ${preview.baseRef} in ${preview.conflicts.length} file${
          preview.conflicts.length === 1 ? '' : 's'
        }:`,
        unrelated: `Cannot say: ${preview.reason ?? 'no shared history'}.`,
        unavailable: `Cannot say: ${preview.reason ?? 'git could not answer'}.`
      }[preview.state]

      const text =
        preview.state === 'conflicts' ? [summary, ...preview.conflicts.map((path) => `  ${path}`)].join('\n') : summary

      // Exit stays 0 for every answer, including "it would conflict": the
      // codes mean whether the command ran, and this one ran. A script branches
      // on `state` from --json rather than on an exit code that would have to
      // be given a second meaning.
      return { data: preview, text }
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
  },
  {
    path: ['worktree', 'start-points'],
    summary: 'List everything a new worktree in a project could branch from.',
    details:
      'The same list the window offers in its create dialog: local branches, remote branches, tags and the ' +
      'current head, newest first. Pass any `ref` back to `worktree create --from`.\n\n' +
      'A repository with thousands of refs is capped rather than dumped; `truncated` says when a tail was ' +
      'dropped and `total` says how many there were.',
    args: [{ name: 'project', description: 'Project id, name, or path.', required: true }],
    flags: [{ name: 'limit', kind: 'number', placeholder: '<count>', description: 'Refs before the list is capped.' }],
    examples: ['teamree worktree start-points api', 'teamree worktree start-points api --limit 10 --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const limit = readNumber(context.flags, 'limit')
      const list = await context.client.call('worktree.startPoints', {
        projectId: project.id,
        ...(limit === undefined ? {} : { limit })
      })

      const table = formatTable(
        ['REF', 'KIND', 'SHA', 'MARK', 'UPDATED'],
        list.options.map((option) => [
          option.ref,
          option.kind,
          option.shortSha,
          [option.isBase ? 'base' : '', option.isCurrent ? 'current' : ''].filter((mark) => mark !== '').join(','),
          new Date(option.updatedAt).toISOString().slice(0, 10)
        ]),
        'No refs to branch from.'
      )
      const footer = list.truncated ? `\n\nShowing ${list.limit} of ${list.total}. Base ref is ${list.baseRef}.` : ''
      return { data: list, text: `${table}${footer}` }
    }
  },
  {
    path: ['worktree', 'layout'],
    summary: "Show how a worktree's panes are arranged and which one has focus.",
    details:
      '`terminal list` says which panes exist; this says where they are and which one the window would type ' +
      'into. Read-only on purpose: the arrangement is changed by operations that mean something — ' +
      '`terminal split`, `terminal close` — rather than by handing a pane tree back.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    examples: ['teamree worktree layout fix-login --json'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const layout = await context.client.call('layout.get', { worktreeId: worktree.id })
      const tree = layout.root === null ? '  (no panes)' : renderPane(layout.root, '  ', layout.focusedTerminalId)
      return {
        data: layout,
        text: [
          formatFields([
            ['worktree', `${worktree.name} (${layout.worktreeId})`],
            ['focused', layout.focusedTerminalId ?? '-']
          ]),
          '',
          'Panes:',
          tree
        ].join('\n')
      }
    }
  }
]

/** One line per node, indented by depth; a split names its axis and its shares. */
function renderPane(node: PaneNode, indent: string, focused: string | null): string {
  if (node.kind === 'leaf') {
    return `${indent}${node.terminalId}${node.terminalId === focused ? '  <- focused' : ''}`
  }
  const shares = node.sizes.map((size) => `${Math.round(size * 100)}%`).join('/')
  return [
    `${indent}${node.direction} split (${shares})`,
    ...node.children.map((child) => renderPane(child, `${indent}  `, focused))
  ].join('\n')
}
