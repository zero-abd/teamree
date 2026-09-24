// Branches a worktree can be opened on as they are, rather than branched from:
// a teammate's, or a pull request's head. The listing leaves out anything
// already checked out, since git refuses a second checkout of one branch.

import { execFile } from 'node:child_process'
import type { BranchEntry, PullRequestEntry } from '../../shared/entities'
import type { GitRunner } from './gitProcess'
import { readWorktreeInventory } from './worktreeInventory'

const REMOTE_PREFIX = 'refs/remotes/origin/'
const LOCAL_PREFIX = 'refs/heads/'

/** Local and origin branches, newest first, one entry per name, none already checked out. */
export async function listOpenableBranches(runner: GitRunner, root: string): Promise<BranchEntry[]> {
  const inventory = await readWorktreeInventory(runner, root)
  const checkedOut = new Set(inventory.flatMap((entry) => (entry.branch === undefined ? [] : [entry.branch])))
  const { stdout } = await runner.run({
    args: [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(committerdate:unix)%00%(authorname)%00%(subject)',
      'refs/heads',
      'refs/remotes/origin'
    ],
    cwd: root,
    readOnly: true,
    timeoutMs: 30_000
  })
  const entries: BranchEntry[] = []
  for (const line of stdout.split('\n')) {
    const [ref = '', date = '0', author = '', subject = ''] = line.split('\0')
    const remote = ref.startsWith(REMOTE_PREFIX)
    const name = remote ? ref.slice(REMOTE_PREFIX.length) : ref.slice(LOCAL_PREFIX.length)
    if (!remote && !ref.startsWith(LOCAL_PREFIX)) continue
    if (name === '' || name === 'HEAD' || checkedOut.has(name)) continue
    entries.push({
      name,
      checkout: remote ? `origin/${name}` : name,
      remote,
      updatedAt: Number(date) * 1000,
      author,
      subject
    })
  }
  // A local branch is the one to open; its origin twin is the same work.
  const local = new Set(entries.filter((entry) => !entry.remote).map((entry) => entry.name))
  return entries.filter((entry) => !entry.remote || !local.has(entry.name))
}

/** The local branch a `checkout` value names: `origin/x` is `x`, `pull/7/head` is `pr-7`. */
export function branchForCheckout(checkout: string): string {
  const pull = /^pull\/(\d+)\/head$/.exec(checkout)
  if (pull) return `pr-${pull[1]}`
  return checkout.startsWith('origin/') ? checkout.slice('origin/'.length) : checkout
}

export type PullRequestRead = { available: boolean; reason: string | null; pullRequests: PullRequestEntry[] }

type GhPullRequest = {
  number: number
  title: string
  author?: { login?: string } | null
  headRefName: string
  baseRefName: string
  isCrossRepository?: boolean
  updatedAt?: string
}

/** Open pull requests through `gh`; its absence or refusal is `available: false`, never a throw. */
export async function listPullRequests(gh: string | null, root: string): Promise<PullRequestRead> {
  if (gh === null) return { available: false, reason: 'gh not installed', pullRequests: [] }
  const fields = 'number,title,author,headRefName,baseRefName,isCrossRepository,updatedAt'
  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        gh,
        ['pr', 'list', '--state', 'open', '--limit', '50', '--json', fields],
        { cwd: root, timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } },
        (error, out, err) => (error ? reject(new Error(String(err || error.message))) : resolve(out))
      )
    })
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
    return { available: false, reason, pullRequests: [] }
  }
  let parsed: GhPullRequest[]
  try {
    parsed = JSON.parse(stdout) as GhPullRequest[]
    if (!Array.isArray(parsed)) throw new Error('not a list')
  } catch {
    return { available: false, reason: 'gh printed something that is not a list', pullRequests: [] }
  }
  return {
    available: true,
    reason: null,
    pullRequests: parsed.map((pull) => {
      const checkout = pull.isCrossRepository ? `pull/${pull.number}/head` : `origin/${pull.headRefName}`
      const updatedAt = pull.updatedAt === undefined ? Number.NaN : Date.parse(pull.updatedAt)
      return {
        number: pull.number,
        title: pull.title,
        author: pull.author?.login ?? '',
        branch: branchForCheckout(checkout),
        checkout,
        base: `origin/${pull.baseRefName}`,
        updatedAt: Number.isNaN(updatedAt) ? null : updatedAt
      }
    })
  }
}
