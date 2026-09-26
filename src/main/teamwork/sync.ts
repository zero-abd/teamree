// Bringing a checkout's branch up to its remote without touching anybody's uncommitted work.
// Commits are replayed with `merge-tree` and the checkout moved with a two-tree `read-tree`,
// which keeps staged and unstaged changes and refuses rather than overwrites.

import type { GitRunner } from '../git/gitProcess'

const FETCH_TIMEOUT_MS = 60_000

/** Everything teamree itself writes into a repository. */
const TEAMREE_DIR = '.teamree/'

/**
 * `incoming: 'teamree'` moves only when the remote's new commits touch `.teamree/` alone;
 * `replay` says which unpushed local commits may be rebuilt on top of the remote.
 */
export type CatchUpScope = { incoming: 'any' | 'teamree'; replay: 'none' | 'teamree' | 'all' }

export type CatchUp =
  | { ok: true; moved: boolean }
  | {
      ok: false
      /** `scope`: commits the scope does not cover; `local`: uncommitted changes in the way. */
      why: 'fetch' | 'scope' | 'conflict' | 'local'
      paths: string[]
      detail: string
    }

export type CatchUpTarget = {
  cwd: string
  remote: string
  branch: string
  scope: CatchUpScope
  /** False when the caller has just fetched. */
  fetch?: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

/** Fetches `remote/branch` and moves the checkout's branch onto it, within `scope`. */
export async function catchUp(runner: GitRunner, target: CatchUpTarget): Promise<CatchUp> {
  const { cwd, remote, branch, signal } = target
  const read = { cwd, readOnly: true, timeoutMs: 30_000, ...(signal ? { signal } : {}) }
  const git = (args: string[]) => runner.tryRun({ args, ...read })
  const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

  if (target.fetch !== false) {
    const fetched = await fetchBranch(runner, target)
    if (fetched !== null) return fetched
  }

  const theirs = await revParse(runner, cwd, `refs/remotes/${remote}/${branch}`, signal)
  const head = await revParse(runner, cwd, 'HEAD', signal)
  if (theirs === null || head === null) return { ok: true, moved: false }
  if ((await git(['merge-base', '--is-ancestor', theirs, head])).exitCode === 0) return { ok: true, moved: false }

  if (target.scope.incoming === 'teamree') {
    const base = (await git(['merge-base', head, theirs])).stdout.trim()
    const outside = outsideTeamree(lines((await git(['diff', '--name-only', base, theirs])).stdout))
    if (base === '' || outside.length > 0)
      return refused('scope', outside, `${remote}/${branch} changes more than .teamree`)
  }

  const unpushed = lines((await git(['rev-list', '--reverse', `${theirs}..${head}`])).stdout)
  let tip = theirs
  if (unpushed.length > 0) {
    if (target.scope.replay === 'none') return refused('scope', [], `${branch} has commits ${remote} does not`)
    if (lines((await git(['rev-list', '--merges', `${theirs}..${head}`])).stdout).length > 0) {
      return refused('scope', [], `${branch} has a merge ${remote} does not`)
    }
    for (const commit of unpushed) {
      const touched = lines((await git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).stdout)
      if (target.scope.replay === 'teamree' && outsideTeamree(touched).length > 0) {
        return refused('scope', outsideTeamree(touched), `${branch} has commits of its own ${remote} does not`)
      }
      const replayed = await replay(runner, cwd, commit, tip, signal)
      if (!replayed.ok) return replayed
      tip = replayed.sha
    }
  }

  // A stale stat cache makes read-tree call an unchanged file "not uptodate".
  await runner.tryRun({ args: ['update-index', '-q', '--refresh'], cwd, timeoutMs: 30_000 })
  const moved = await runner.tryRun({ args: ['read-tree', '-m', '-u', head, tip], cwd, timeoutMs: 120_000 })
  if (moved.exitCode !== 0) return refused('local', pathsIn(moved.stderr), moved.stderr.trim())
  const updated = await runner.tryRun({
    args: ['update-ref', '-m', `teamree: pull ${remote}/${branch}`, 'HEAD', tip, head],
    cwd,
    timeoutMs: 30_000
  })
  if (updated.exitCode !== 0) return refused('local', [], updated.stderr.trim())
  return { ok: true, moved: true }
}

/** Null once fetched, or once the remote turns out to have no such branch yet. */
async function fetchBranch(runner: GitRunner, target: CatchUpTarget): Promise<CatchUp | null> {
  const { cwd, remote, branch, signal } = target
  const fetched = await runner.tryRun({
    args: ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    cwd,
    timeoutMs: FETCH_TIMEOUT_MS,
    // An inherited askpass would open a window; a credential git must ask for fails the fetch instead.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...target.env },
    ...(signal ? { signal } : {})
  })
  if (fetched.exitCode === 0) return null
  if (/couldn't find remote ref/i.test(fetched.stderr)) return { ok: true, moved: false }
  return refused('fetch', [], fetched.stderr.trim() || `git fetch exited ${fetched.exitCode}`)
}

/** `commit` rebuilt on `onto`, keeping its author and message; never touches the index or the tree. */
async function replay(
  runner: GitRunner,
  cwd: string,
  commit: string,
  onto: string,
  signal?: AbortSignal
): Promise<{ ok: true; sha: string } | Extract<CatchUp, { ok: false }>> {
  const read = { cwd, readOnly: true, timeoutMs: 60_000, ...(signal ? { signal } : {}) }
  const merged = await runner.tryRun({
    args: ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${commit}^`, onto, commit],
    ...read
  })
  const [tree = '', ...conflicted] = merged.stdout.split('\n').filter((line) => line.length > 0)
  if (merged.exitCode === 1) return refused('conflict', conflicted, `${conflicted.join(', ')} changed on both sides`)
  if (merged.exitCode !== 0) return refused('conflict', [], merged.stderr.trim())

  const meta = await runner.run({ args: ['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', commit], ...read })
  const [name = '', email = '', date = '', ...message] = meta.stdout.split('\0')
  const made = await runner.run({
    args: ['commit-tree', tree, '-p', onto, '-F', '-'],
    ...read,
    stdin: message.join('\0'),
    env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }
  })
  return { ok: true, sha: made.stdout.trim() }
}

async function revParse(runner: GitRunner, cwd: string, ref: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    cwd,
    readOnly: true,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {})
  })
  const sha = result.stdout.trim()
  return result.exitCode === 0 && sha !== '' ? sha : null
}

function outsideTeamree(paths: readonly string[]): string[] {
  return paths.filter((path) => !path.startsWith(TEAMREE_DIR))
}

/** The paths read-tree named, from `Entry 'x' not uptodate` or `Untracked working tree file 'x'`. */
function pathsIn(stderr: string): string[] {
  return [...stderr.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
}

function refused(
  why: Extract<CatchUp, { ok: false }>['why'],
  paths: string[],
  detail: string
): CatchUp & { ok: false } {
  return { ok: false, why, paths, detail }
}
