import type { ParamsOf } from '../../shared/methods.js'
import type { SearchFileHits, SearchSummary, WorktreeSearchEvent } from '../../shared/search.js'
import type { CommandSpec } from '../command-spec.js'
import { readBoolean, readNumber, readStrings } from '../argv.js'
import { CliError, ExitCode } from '../exit.js'
import { resolveWorktree } from '../selectors.js'
import type { RuntimeClient } from '../transport.js'

export type SearchCollection = { files: SearchFileHits[]; summary: SearchSummary }

/** Subscribes, gathers every batch, and returns at `done` or when the budget runs out. */
export async function collectSearch(
  client: RuntimeClient,
  params: ParamsOf<'worktree.search'>,
  budgetMs: number
): Promise<SearchCollection> {
  const files: SearchFileHits[] = []
  let summary: SearchSummary | undefined
  const subscription = await client.subscribe('worktree.search', params, (raw) => {
    const event = raw as WorktreeSearchEvent
    if (event.type === 'hits') files.push(...event.files)
    else {
      const { type: _done, ...rest } = event
      summary = rest
    }
  })
  const started = Date.now()
  while (summary === undefined && Date.now() - started < budgetMs)
    await new Promise((resolve) => setTimeout(resolve, 20))
  if (summary === undefined) {
    await subscription.unsubscribe().catch(() => {})
    throw new CliError({ code: 'timeout', message: 'The search did not finish in time.', exitCode: ExitCode.Failure })
  }
  return { files, summary }
}

/** grep's shape, `task:path:line:text`, with the task only when there are several. */
export function searchText(result: SearchCollection, names: ReadonlyMap<string, string>, withTask: boolean): string {
  if (result.summary.error !== undefined) return `Search failed: ${result.summary.error}`
  const lines = result.files.flatMap((file) =>
    file.lines.map((hit) => {
      const task = withTask ? `${names.get(file.worktreeId) ?? file.worktreeId}:` : ''
      return `${task}${file.path}:${hit.line}:${hit.text}`
    })
  )
  if (lines.length === 0) return 'No matches.'
  const files = new Set(result.files.map((file) => `${file.worktreeId}\0${file.path}`)).size
  const tail = `${result.summary.matches} ${result.summary.matches === 1 ? 'match' : 'matches'} in ${files} ${
    files === 1 ? 'file' : 'files'
  }${result.summary.truncated ? ' (capped)' : ''}${result.summary.timedOut ? ' (timed out)' : ''}`
  return `${lines.join('\n')}\n\n${tail}`
}

export const worktreeSearchCommands: readonly CommandSpec[] = [
  {
    path: ['worktree', 'search'],
    summary: 'Search file contents in a worktree, or in every worktree of its project.',
    details:
      'Uses ripgrep when it is on PATH, else git grep; both skip what .gitignore ignores. ' +
      'Literal and case-insensitive unless told otherwise. Stops at 2000 matching lines.',
    args: [
      { name: 'worktree', description: 'Worktree id, name, path, branch, or here.', required: true },
      { name: 'query', description: 'The text to find.', required: true }
    ],
    flags: [
      { name: 'all', kind: 'boolean', description: "Every worktree of the worktree's project." },
      { name: 'regex', kind: 'boolean', description: 'Read the query as a regular expression.' },
      { name: 'case', kind: 'boolean', description: 'Match case.' },
      { name: 'word', kind: 'boolean', description: 'Whole words only.' },
      {
        name: 'include',
        kind: 'string',
        repeatable: true,
        placeholder: '<glob>',
        description: 'Only paths matching; repeatable. A leading ! excludes.'
      },
      { name: 'limit', kind: 'number', placeholder: '<lines>', description: 'Matching lines before it stops.' }
    ],
    examples: [
      'teamree worktree search here "limit("',
      'teamree worktree search fix-login "limit\\(\\d" --regex --all',
      'teamree worktree search api useAuth --include "src/**" --include "!*.test.ts" --json'
    ],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, context.args[0] as string)
      const query = context.args[1] as string
      const all = readBoolean(context.flags, 'all')
      const include = readStrings(context.flags, 'include')
      const limit = readNumber(context.flags, 'limit')
      const result = await collectSearch(
        context.client,
        {
          ...(all ? { projectId: worktree.projectId } : { worktreeId: worktree.id }),
          query,
          ...(readBoolean(context.flags, 'regex') ? { regex: true } : {}),
          ...(readBoolean(context.flags, 'case') ? { caseSensitive: true } : {}),
          ...(readBoolean(context.flags, 'word') ? { wholeWord: true } : {}),
          ...(include.length === 0 ? {} : { include }),
          ...(limit === undefined ? {} : { limit })
        },
        30_000
      )
      const names = new Map((await context.client.call('worktree.list', {})).map((entry) => [entry.id, entry.name]))
      return { data: result, text: searchText(result, names, all) }
    }
  }
]
