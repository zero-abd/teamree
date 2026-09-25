import type { PaneNode, Worktree, WorktreeCompare } from '../../shared/entities.js'
import { MAX_AGENT_ARGS_CHARS } from '../../shared/agentLaunch.js'
import { parsePatch, type PatchHunk } from '../../shared/patch.js'
import { compareRuns, type RunFile } from '../../shared/runCompare.js'
import { taskNamesForAgents } from '../../main/git/worktreeNaming.js'
import type { CommandContext, CommandSpec } from '../command-spec.js'
import { readBoolean, readNumber, readString, readStrings, requireString } from '../argv.js'
import { formatFields, formatTable } from '../output.js'
import { resolveProject, resolveWorktree } from '../selectors.js'
import { DEFAULT_WAIT_TIMEOUT_MS, waitForState } from '../waiting.js'
import { CliError, ExitCode } from '../exit.js'

/**
 * The task `--prompt` names, or undefined. Refused before any checkout exists
 * when too long for one command line or when there is no agent to give it to.
 */
async function readPrompt(context: CommandContext, agents: number): Promise<string | undefined> {
  const flag = readString(context.flags, 'prompt')
  if (flag === undefined) return undefined
  if (agents === 0) {
    throw new CliError({
      code: 'prompt_without_agent',
      message: '--prompt is given to an agent; add --agent <command>.',
      exitCode: ExitCode.Usage
    })
  }
  const text = (flag === '-' ? await context.stdin() : flag).trim()
  if (text.length === 0) {
    throw new CliError({ code: 'empty_prompt', message: '--prompt is empty.', exitCode: ExitCode.Usage })
  }
  if (text.length > MAX_AGENT_ARGS_CHARS) {
    throw new CliError({
      code: 'prompt_too_long',
      message: `--prompt is ${text.length} characters; the most one command line takes is ${MAX_AGENT_ARGS_CHARS}.`,
      exitCode: ExitCode.Usage
    })
  }
  return text
}

/**
 * The state column of a listing. `missing` is the disk disagreeing with a
 * `ready` record, but a listing read by eye has one column for it; --json has both.
 */
export function shownState(worktree: Pick<Worktree, 'state' | 'missing'>): string {
  return worktree.missing ? 'missing' : worktree.state
}

/** Both runs and their start, each file with what each run did to it, then the patches, one for a file both changed alike. */
export function compareText(result: WorktreeCompare, a: Worktree, b: Worktree): string {
  const files = compareRuns(result.left.patch, result.right.patch)
  const stat = (run: RunFile | null): string => (run === null ? '-' : `+${run.added} -${run.removed}`)
  const table = formatTable(
    ['FILE', 'A', 'B', ''],
    files.map((file) => [
      file.path,
      stat(file.left),
      stat(file.right),
      file.same ? 'same' : file.left === null ? 'only b' : file.right === null ? 'only a' : ''
    ]),
    'Neither run has changed anything.'
  )
  const patches = files.flatMap((file) => {
    if (file.same && file.left !== null) return [`== a b  ${file.path}\n${file.left.patch.trimEnd()}`]
    return [
      ...(file.left === null ? [] : [`== a  ${file.path}\n${file.left.patch.trimEnd()}`]),
      ...(file.right === null ? [] : [`== b  ${file.path}\n${file.right.patch.trimEnd()}`])
    ]
  })
  const cut = result.left.truncated || result.right.truncated ? ['[cut short]'] : []
  const head = formatFields([
    ['a', a.name],
    ['b', b.name],
    ['base', result.base.slice(0, 7)]
  ])
  return [head, table, ...patches, ...cut].join('\n\n')
}

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
          worktrees.map((worktree) => [
            worktree.id,
            worktree.name,
            worktree.branch,
            shownState(worktree),
            worktree.path
          ]),
          'No worktrees. Create one with: teamree worktree create --project <id> --name <name>'
        )
      }
    }
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a worktree and its branch.',
    details:
      'Returns as soon as the runtime accepts the requests; the rows may still be in the "creating" state.\n' +
      'Repeat --agent to race one task in several checkouts: each gets its own worktree from the same ' +
      'start point, and its agent is started once the checkout is ready.\n' +
      'One agent keeps --name; several name each worktree "<name> <agent>", numbering a repeated agent ' +
      'from its second run.\n' +
      '--prompt is the task: written on each worktree record and given to each agent as its first prompt. ' +
      'Pass - to read it from stdin.\n' +
      'With --agent, --json carries every created record as a list; without it, the one record as before.',
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
        description: 'Explicit branch name instead of one derived from --name. One worktree only.'
      },
      {
        name: 'agent',
        kind: 'string',
        placeholder: '<command>',
        repeatable: true,
        description: 'Start this command in the new worktree. Repeat it for one worktree each.'
      },
      {
        name: 'prompt',
        kind: 'string',
        placeholder: '<text>',
        description: 'The task, handed to each --agent as its first prompt and kept on the worktree. - reads stdin.'
      },
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `How long to wait for each checkout before starting its agent. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`
      }
    ],
    examples: [
      'teamree worktree create --project api --name fix-login --from origin/main',
      'teamree worktree create --project api --name fix-login --agent claude --agent claude --agent codex',
      'teamree worktree create --project api --name fix-login --agent claude --prompt "Fix the login form; it posts twice."'
    ],
    run: async (context) => {
      const project = await resolveProject(context.client, requireString(context.flags, 'project'))
      const startedFrom = readString(context.flags, 'from')
      const branch = readString(context.flags, 'branch')
      const agents = readStrings(context.flags, 'agent')
      const timeoutMs = readNumber(context.flags, 'timeout-ms') ?? DEFAULT_WAIT_TIMEOUT_MS
      const task = await readPrompt(context, agents.length)

      // One branch name cannot answer for several checkouts.
      if (branch !== undefined && agents.length > 1) {
        throw new CliError({
          code: 'branch_for_several',
          message: '--branch names one branch, so it cannot be used with more than one --agent.',
          exitCode: ExitCode.Usage
        })
      }

      // Each name is used twice: for the checkout and for the pane that runs in it.
      const names = taskNamesForAgents(requireString(context.flags, 'name'), agents)

      // In order: the runtime allocates branches as the requests arrive.
      const created: Worktree[] = []
      for (const name of names) {
        created.push(
          await context.client.call('worktree.create', {
            projectId: project.id,
            name,
            ...(startedFrom === undefined ? {} : { startedFrom }),
            ...(branch === undefined ? {} : { branch }),
            ...(task === undefined ? {} : { task })
          })
        )
      }

      // In parallel: a race whose second agent waits for the first checkout is not a race.
      const started = await Promise.all(
        created.map(async (worktree, index) => {
          const agent = agents[index]
          if (agent === undefined) return worktree
          const ready = await waitForCheckout(context, worktree, timeoutMs)
          // Named for the worktree, suffix and all, not the binary: three panes
          // called `claude` cannot be told apart in a listing.
          await context.client.call('terminal.create', {
            worktreeId: ready.id,
            command: agent,
            label: names[index] as string,
            ...(task === undefined ? {} : { prompt: task })
          })
          return ready
        })
      )

      // `taskNamesForAgents` hands out one name for a selection of none.
      const one = started[0] as Worktree
      if (agents.length === 0) {
        return {
          data: one,
          text: formatFields([
            ['id', one.id],
            ['name', one.name],
            ['branch', one.branch],
            ['from', one.startedFrom],
            ['state', one.state],
            ['path', one.path]
          ])
        }
      }

      return {
        data: started,
        text: formatTable(
          ['ID', 'NAME', 'BRANCH', 'AGENT', 'STATE', 'PATH'],
          started.map((worktree, index) => [
            worktree.id,
            worktree.name,
            worktree.branch,
            agents[index] as string,
            worktree.state,
            worktree.path
          ]),
          'No worktrees.'
        )
      }
    }
  },
  {
    path: ['worktree', 'remove'],
    summary: 'Move a worktree to the trash: delete its checkout, keeping a copy restore can bring back.',
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
    path: ['worktree', 'forget'],
    summary: 'Remove a worktree from teamree; its checkout and branch stay on disk.',
    details: 'Open Branch in the app, or worktree create --checkout <branch>, takes the checkout back as it is.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    examples: ['teamree worktree forget fix-login'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const result = await context.client.call('worktree.forget', { worktreeId: worktree.id })
      return {
        data: { ...result, worktree },
        text: `removed worktree ${worktree.name} from teamree; its checkout is at ${worktree.path}`
      }
    }
  },
  {
    path: ['worktree', 'restore'],
    summary: 'Bring back a removed worktree with its uncommitted work.',
    details:
      'Remove keeps a copy of the checkout for 14 days. With no argument, lists what can be restored, newest first.',
    args: [
      {
        name: 'worktree',
        description: 'Removed worktree: copy id, worktree id, name, or branch; the newest match.',
        required: false
      }
    ],
    examples: ['teamree worktree restore', 'teamree worktree restore fix-login'],
    run: async (context) => {
      const removed = await context.client.call('worktree.removed', { limit: 50 })
      const wanted = context.args[0]
      if (wanted === undefined) {
        return {
          data: removed,
          text: formatTable(
            ['ID', 'NAME', 'BRANCH', 'REMOVED'],
            removed.map((entry) => [entry.id, entry.name, entry.branch, new Date(entry.removedAt).toISOString()]),
            'Nothing to restore.'
          )
        }
      }
      const match = removed.find((entry) => [entry.id, entry.worktreeId, entry.name, entry.branch].includes(wanted))
      if (match === undefined) {
        throw new CliError({
          code: 'not_found',
          message: `no removed worktree matches "${wanted}"; list them with: teamree worktree restore`,
          exitCode: ExitCode.Failure
        })
      }
      const worktree = await context.client.call('worktree.restore', {
        projectId: match.projectId,
        removedId: match.id
      })
      return { data: worktree, text: `restored worktree ${worktree.name} (${worktree.id}) at ${worktree.path}` }
    }
  },
  {
    path: ['worktree', 'rename'],
    summary: 'Rename a worktree.',
    details: 'Changes the name shown everywhere. The branch and the checkout path stay as they are.',
    args: [
      { name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true },
      { name: 'name', description: 'The new name.', required: true }
    ],
    examples: ['teamree worktree rename "fix login claude" "fix login"'],
    run: async (context) => {
      const name = (context.args[1] as string).trim()
      if (name.length === 0) {
        throw new CliError({ code: 'empty_name', message: '<name> is empty.', exitCode: ExitCode.Usage })
      }
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const renamed = await context.client.call('worktree.rename', { worktreeId: worktree.id, name })
      return { data: renamed, text: `renamed worktree ${worktree.name} to ${renamed.name} (${renamed.id})` }
    }
  },
  {
    path: ['worktree', 'status'],
    summary: 'Show live git status for one worktree.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const status = await context.client.call('worktree.status', { worktreeId: worktree.id })
      const head: [string, string][] = [
        ['worktree', `${worktree.name} (${status.worktreeId})`],
        ['branch', status.branch]
      ]
      const readAt: [string, string] = ['read at', new Date(status.readAt).toISOString()]
      // No counts for a missing checkout: a zero here reads as "clean".
      const counts: [string, string][] = status.missing
        ? [['checkout', 'missing']]
        : [
            ['ahead/behind', `${status.ahead}/${status.behind}`],
            ['staged', String(status.staged)],
            ['unstaged', String(status.unstaged)],
            ['untracked', String(status.untracked)],
            ['conflicted', String(status.conflicted)]
          ]
      return { data: status, text: formatFields([...head, ...counts, readAt]) }
    }
  },
  {
    path: ['worktree', 'changes'],
    summary: 'List the changed paths in a worktree.',
    details: 'Conflicts first, then what is staged, then the rest.',
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
      'Nothing is staged for you beyond the paths you name. With no paths, it commits what is already ' +
      'staged and refuses if that is nothing. There is no "commit everything".',
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
    path: ['worktree', 'stage-hunk'],
    summary: 'Put one hunk of a file into the index.',
    details:
      'Hunks are numbered from 1, in the order `teamree worktree diff --path <file>` prints them.\n' +
      'Only the index is written; the file on disk is never touched. Staging one hunk renumbers the rest, ' +
      'so read the patch again between calls rather than counting ahead.\n' +
      'Untracked and binary files stage whole: use `worktree commit -- <path>`.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'path',
        kind: 'string',
        placeholder: '<path>',
        description: 'The file the hunk is in.',
        required: true
      },
      { name: 'hunk', kind: 'number', placeholder: '<n>', description: 'Which hunk of that file, from 1.' }
    ],
    examples: [
      'teamree worktree stage-hunk fix-login --path src/app.ts --hunk 2',
      'teamree worktree stage-hunk fix-login --path src/app.ts --hunk 1 --json'
    ],
    run: async (context) => applyHunkCommand(context, true)
  },
  {
    path: ['worktree', 'unstage-hunk'],
    summary: 'Take one hunk of a file back out of the index.',
    details:
      'The mirror of stage-hunk, numbered against the staged patch — what ' +
      '`teamree worktree diff --path <file> --staged` prints.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'path',
        kind: 'string',
        placeholder: '<path>',
        description: 'The file the hunk is in.',
        required: true
      },
      { name: 'hunk', kind: 'number', placeholder: '<n>', description: 'Which hunk of that file, from 1.' }
    ],
    examples: ['teamree worktree unstage-hunk fix-login --path src/app.ts --hunk 1'],
    run: async (context) => applyHunkCommand(context, false)
  },
  {
    path: ['worktree', 'unstage'],
    summary: 'Take a whole file out of the index.',
    details: 'Only the index is written; the file on disk is never touched. A staged rename is unstaged on both sides.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'path',
        kind: 'string',
        placeholder: '<path>',
        description: 'The file to unstage.',
        required: true
      }
    ],
    examples: ['teamree worktree unstage fix-login --path src/app.ts'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const patchPath = requireString(context.flags, 'path')
      const result = await context.client.call('worktree.unstagePath', { worktreeId: worktree.id, path: patchPath })
      return { data: result, text: formatFields([['unstaged', patchPath]]) }
    }
  },
  {
    path: ['worktree', 'discard'],
    summary: "Throw away a file's unstaged change, or one hunk of it.",
    details:
      'The index is never written, so what is staged stays. A tracked file goes back to its staged, else ' +
      'committed, content; an untracked file goes to the Trash. With --hunk, hunks are numbered as ' +
      '`teamree worktree diff --path <file>` prints them.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [
      {
        name: 'path',
        kind: 'string',
        placeholder: '<path>',
        description: 'The file to discard.',
        required: true
      },
      { name: 'hunk', kind: 'number', placeholder: '<n>', description: 'Only this hunk of that file, from 1.' }
    ],
    examples: [
      'teamree worktree discard fix-login --path src/app.ts',
      'teamree worktree discard fix-login --path src/app.ts --hunk 2'
    ],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const patchPath = requireString(context.flags, 'path')
      if (readNumber(context.flags, 'hunk') === undefined) {
        const result = await context.client.call('worktree.discardPath', { worktreeId: worktree.id, path: patchPath })
        return { data: result, text: formatFields([[result.outcome, patchPath]]) }
      }
      const { wanted, hunk } = await readHunk(context, worktree.id, patchPath, false)
      const result = await context.client.call('worktree.discardHunk', {
        worktreeId: worktree.id,
        path: patchPath,
        hunk: wireHunk(hunk)
      })
      return { data: result, text: formatFields([['discarded', `hunk ${wanted} of ${patchPath}`]]) }
    }
  },
  {
    path: ['worktree', 'push'],
    summary: "Send a worktree's branch to its remote.",
    details:
      'Sets the upstream on the first push. There is no force push. Uncommitted work is reported, not ' +
      'blocked, and stays behind. Prints a review URL when the remote is a forge it recognises.',
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
      // On its own line: the next thing that happens to it is a click or a copy.
      if (result.reviewUrl !== undefined) lines.push(result.reviewUrl)
      return { data: result, text: lines.join('\n') }
    }
  },
  {
    path: ['worktree', 'land'],
    summary: "Open a pull request for a worktree's branch, or merge it into the base.",
    details:
      'On GitHub, GitLab or Bitbucket: a pull request for the published branch, made with gh when it is ' +
      'signed in, else the URL that opens one. Any other origin, or --merge: merges the branch into the ' +
      "base branch in the project's own checkout, fast-forward when it can; refused over uncommitted work there.",
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [{ name: 'merge', kind: 'boolean', description: 'Merge into the base even on a known host.' }],
    examples: ['teamree worktree land fix-login', 'teamree worktree land fix-login --merge'],
    run: async (context) => {
      const selector = context.args[0] as string
      const worktree = await resolveWorktree(context.client, selector)
      const landing = await context.client.call('worktree.landing', { worktreeId: worktree.id })
      if (landing.merged) {
        return { data: landing, text: `${landing.branch} is already in ${landing.base}.` }
      }
      if (landing.host === null || readBoolean(context.flags, 'merge')) {
        const merged = await context.client.call('worktree.mergeIntoBase', { worktreeId: worktree.id })
        const how = merged.fastForward ? 'fast-forward' : 'merge commit'
        return { data: merged, text: `Merged ${landing.branch} into ${merged.into} in ${merged.checkout} (${how}).` }
      }
      if (!landing.published) {
        throw new CliError({
          code: 'not_published',
          message: `${landing.branch} is not on origin yet. Push it first: teamree worktree push ${selector}`,
          exitCode: ExitCode.Failure
        })
      }
      const made = await context.client.call('worktree.createPullRequest', { worktreeId: worktree.id })
      const said = made.number === undefined ? 'Open a pull request at:' : `Pull request #${made.number}:`
      return { data: made, text: `${said}\n${made.url}` }
    }
  },
  {
    path: ['worktree', 'keep'],
    summary: "Keep one run of a task and remove the task's other runs.",
    details:
      'Every other worktree made for the same task is removed; their branches stay. The kept run is named ' +
      'after the task again. Refused while another run holds uncommitted or ignored files, unless --force.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: true }],
    flags: [{ name: 'force', kind: 'boolean', description: "Remove the other runs' uncommitted work too." }],
    examples: ['teamree worktree keep "fix login claude"'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const force = readBoolean(context.flags, 'force')
      const kept = await context.client.call(
        'worktree.keep',
        force ? { worktreeId: worktree.id, force } : { worktreeId: worktree.id }
      )
      const count = kept.removed.length
      const removed = `removed ${count} other run${count === 1 ? '' : 's'}`
      const branches = count === 1 ? 'Its branch is still there.' : 'Their branches are still there.'
      return { data: kept, text: `Kept ${kept.worktree.name}; ${removed}.${count === 0 ? '' : ` ${branches}`}` }
    }
  },
  {
    path: ['worktree', 'log'],
    summary: 'List the commits a worktree has made that its base has not.',
    details: 'Scoped to base..branch, newest first.',
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
      'Answered without checking anything out or starting a merge. The answer is in `state` under --json: ' +
      'clean, conflicts, unrelated, or unavailable.',
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

      // Exit 0 even for "it would conflict": exit codes say whether the command
      // ran; a script branches on `state` from --json.
      return { data: preview, text }
    }
  },
  {
    path: ['worktree', 'diff'],
    summary: 'Print the patch for a worktree, or for one path in it.',
    details: 'Untracked files are included when --path names one; git alone would print nothing for them.',
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

      // As git wrote it, so it can be piped into `git apply`.
      const text = result.patch === '' ? 'No changes.' : result.patch
      return { data: result, text: result.truncated ? `${text}\n[cut at ${result.patch.length} characters]` : text }
    }
  },
  {
    path: ['worktree', 'compare'],
    summary: 'Compare two runs of a task, each against the commit both started from.',
    details:
      'Uncommitted and untracked work is included. Each file is listed with what each run did to it, then the patches.',
    args: [
      { name: 'a', description: 'Worktree id, name, path, or branch.', required: true },
      { name: 'b', description: 'Worktree id, name, path, or branch.', required: true }
    ],
    flags: [
      { name: 'context', kind: 'number', placeholder: '<lines>', description: 'Context lines around each hunk.' },
      {
        name: 'max-bytes',
        kind: 'number',
        placeholder: '<bytes>',
        description: 'Ceiling on each run’s patch. It is cut at a line boundary.'
      }
    ],
    examples: ['teamree worktree compare "fix-login claude" "fix-login codex"', 'teamree worktree compare a b --json'],
    run: async (context) => {
      const [a, b] = await Promise.all([
        resolveWorktree(context.client, context.args[0] as string),
        resolveWorktree(context.client, context.args[1] as string)
      ])
      const contextLines = readNumber(context.flags, 'context')
      const maxBytes = readNumber(context.flags, 'max-bytes')
      const result = await context.client.call('worktree.compare', {
        worktreeId: a.id,
        otherId: b.id,
        ...(contextLines === undefined ? {} : { contextLines }),
        ...(maxBytes === undefined ? {} : { maxBytes })
      })
      return {
        data: { ...result, files: compareRuns(result.left.patch, result.right.patch) },
        text: compareText(result, a, b)
      }
    }
  },
  {
    path: ['worktree', 'wait'],
    summary: 'Block until a worktree finishes being created.',
    details: 'Exits non-zero if the worktree settled as failed.',
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
      'Local branches, remote branches, tags and the current head, newest first. Pass any `ref` back to ' +
      '`worktree create --from`.\n\n' +
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
          // Git's %ct is seconds; Date wants milliseconds.
          new Date(option.updatedAt * 1000).toISOString().slice(0, 10)
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
    details: 'Read-only: change the arrangement with `terminal split` and `terminal close`.',
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

/**
 * Blocks until one checkout exists, because an agent started before it does has
 * nowhere to run. A worktree that settles as failed is reported as such rather
 * than having a pane opened in it.
 */
async function waitForCheckout(context: CommandContext, worktree: Worktree, timeoutMs: number): Promise<Worktree> {
  const settled = await waitForState({
    client: context.client,
    what: `worktree ${worktree.name}`,
    read: async () => {
      const rows = await context.client.call('worktree.list', {})
      return rows.find((row) => row.id === worktree.id)
    },
    settled: (row) => row === undefined || row.state === 'ready' || row.state === 'failed',
    timeoutMs
  })
  if (settled === undefined || settled.state !== 'ready') {
    throw new CliError({
      code: 'worktree_failed',
      message: `Worktree ${worktree.name} never became ready: ${settled?.error ?? settled?.state ?? 'it disappeared'}`,
      exitCode: ExitCode.Failure,
      ...(settled === undefined ? {} : { data: settled })
    })
  }
  return settled
}

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

/**
 * Both hunk commands, differing only in which patch they count against and
 * which method they end in. The index goes stale the instant anything else
 * stages a hunk, so it is resolved here against a patch read one line earlier;
 * the runtime is never handed a position to trust (see `Hunk` in src/shared/methods.ts).
 */
async function applyHunkCommand(context: CommandContext, staged: boolean): Promise<{ data: unknown; text: string }> {
  const worktree = await resolveWorktree(context.client, context.args[0] as string)
  const patchPath = requireString(context.flags, 'path')
  // Read against the side being changed: staging counts hunks of the working
  // tree, unstaging counts hunks of the index.
  const { wanted, hunk } = await readHunk(context, worktree.id, patchPath, !staged)

  const result = await context.client.call(staged ? 'worktree.stageHunk' : 'worktree.unstageHunk', {
    worktreeId: worktree.id,
    path: patchPath,
    hunk: wireHunk(hunk)
  })

  return {
    data: result,
    text: formatFields([
      [staged ? 'staged' : 'unstaged', `hunk ${wanted} of ${patchPath}`],
      ['lines', `+${result.added} -${result.removed}`]
    ])
  }
}

/** The `--hunk`th hunk of one side of a path's patch, read just now. */
async function readHunk(
  context: CommandContext,
  worktreeId: string,
  patchPath: string,
  fromIndex: boolean
): Promise<{ wanted: number; hunk: PatchHunk }> {
  const wanted = readNumber(context.flags, 'hunk') ?? 1
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new CliError({ code: 'usage', message: '--hunk counts from 1.', exitCode: ExitCode.Usage })
  }

  const diff = await context.client.call('worktree.diff', { worktreeId, path: patchPath, staged: fromIndex })
  const hunks = parsePatch(diff.patch).flatMap((file) => file.hunks)
  const hunk = hunks[wanted - 1]
  if (hunk === undefined) {
    throw new CliError({
      code: 'not_found',
      message:
        hunks.length === 0
          ? `No ${fromIndex ? 'staged ' : ''}hunks in ${patchPath}.`
          : `${patchPath} has ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}; there is no ${wanted}.`,
      exitCode: ExitCode.Failure
    })
  }
  if (diff.truncated) {
    throw new CliError({
      code: 'conflict',
      message: `The patch for ${patchPath} was cut short, so its hunks cannot be numbered reliably.`,
      exitCode: ExitCode.Failure
    })
  }
  return { wanted, hunk }
}

/** A parsed hunk with the parser's own bookkeeping left off. */
function wireHunk(hunk: PatchHunk): {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: { kind: PatchHunk['lines'][number]['kind']; text: string; noNewline: boolean }[]
} {
  return {
    oldStart: hunk.oldStart,
    oldCount: hunk.oldCount,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
    lines: hunk.lines.map((line) => ({ kind: line.kind, text: line.text, noNewline: line.noNewline }))
  }
}
