// Where a finished worktree goes: a pull request on its host, or a merge into the base
// branch in the project's own checkout. Kept apart from the merge preview, which only reads.

import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import type { WorktreeLanding, WorktreeMerge, WorktreePullRequest } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { assertRefShape } from './repository'
import { bareRef, remoteForge, reviewUrl } from './reviewUrl'
import { parseChangeRecords } from './worktreeChanges'

const REMOTE = 'origin'
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
const SIGN_IN_TTL_MS = 5 * 60_000
const PULL_REQUEST_TTL_MS = 60_000
const MERGE_COMMITS_SHOWN = 50

type PullRequest = NonNullable<WorktreeLanding['pullRequest']>

/** `gh`, found once and asked whether it is signed in at most every five minutes; pull requests cached a minute. */
export type GhProbe = {
  signedIn(cwd: string): Promise<GitRunner | null>
  pullRequest(gh: GitRunner, cwd: string, branch: string): Promise<PullRequest | undefined>
  forget(branch: string): void
}

export function createGhProbe(locate: () => string | null, now: () => number = Date.now): GhProbe {
  let signIn: { runner: GitRunner | null; at: number } | null = null
  const pulls = new Map<string, { pull: PullRequest | undefined; at: number }>()
  return {
    async signedIn(cwd) {
      if (signIn !== null && now() - signIn.at < SIGN_IN_TTL_MS) return signIn.runner
      const binary = locate()
      const runner = binary === null ? null : createGitRunner(binary)
      const status = await runner
        ?.tryRun({ args: ['auth', 'status', '--hostname', 'github.com'], cwd, env: GH_ENV, timeoutMs: 15_000 })
        .catch(() => null)
      signIn = { runner: status?.exitCode === 0 ? runner : null, at: now() }
      return signIn.runner
    },
    async pullRequest(gh, cwd, branch) {
      const cached = pulls.get(branch)
      if (cached !== undefined && now() - cached.at < PULL_REQUEST_TTL_MS) return cached.pull
      const read = await gh
        .tryRun({ args: ['pr', 'view', branch, '--json', 'number,url,state'], cwd, env: GH_ENV, timeoutMs: 30_000 })
        .catch(() => null)
      const pull = read?.exitCode === 0 ? parsePullRequest(read.stdout) : undefined
      // A failed read is not "no pull request"; only an answer is kept.
      if (read !== null) pulls.set(branch, { pull, at: now() })
      return pull
    },
    forget(branch) {
      pulls.delete(branch)
    }
  }
}

/** `gh pr view --json number,url,state`, or undefined for anything else. */
export function parsePullRequest(stdout: string): PullRequest | undefined {
  try {
    const value = JSON.parse(stdout) as { number?: unknown; url?: unknown; state?: unknown }
    const state = typeof value.state === 'string' ? value.state.toLowerCase() : ''
    if (typeof value.number !== 'number' || typeof value.url !== 'string') return undefined
    if (state !== 'open' && state !== 'merged' && state !== 'closed') return undefined
    return { number: value.number, url: value.url, state }
  } catch {
    return undefined
  }
}

/** The first `name` on the app's own PATH, then on the login shell's: a Dock launch is handed neither profile. */
export function findProgram(name: string, paths: readonly (string | undefined)[]): string | null {
  for (const value of paths) {
    for (const directory of (value ?? '').split(path.delimiter)) {
      if (directory.trim() === '') continue
      const candidate = path.join(directory, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here.
      }
    }
  }
  return null
}

export type LandingOptions = {
  worktreeId: string
  worktreePath: string
  branch: string
  baseRef: string
  /** The sha the branch was cut from: a branch that made no commit is not merged, whatever git says. */
  startedFrom: string
  /** A child lands in this worktree's branch, `baseRef`, here and never through its host. */
  parent?: { worktreeId: string; name: string }
  gh?: GhProbe
  now?: () => number
}

export async function readLanding(runner: GitRunner, options: LandingOptions): Promise<WorktreeLanding> {
  assertRefShape(options.branch, 'branch')
  assertRefShape(options.baseRef, 'base ref')
  const cwd = options.worktreePath
  const git = (args: string[]): Promise<{ exitCode: number; stdout: string }> =>
    runner.tryRun({ args, cwd, readOnly: true, timeoutMs: 30_000 })
  const count = async (range: string): Promise<number> => {
    const counted = await git(['rev-list', '--count', range])
    return counted.exitCode === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0
  }
  const isAncestor = async (ref: string): Promise<boolean> =>
    (await git(['merge-base', '--is-ancestor', options.branch, ref])).exitCode === 0

  const base = bareRef(options.baseRef, REMOTE)
  const remoteUrl = options.parent === undefined ? await git(['remote', 'get-url', REMOTE]) : undefined
  const url = remoteUrl?.exitCode === 0 ? remoteUrl.stdout.trim() : ''
  const host = remoteForge(url)
  const published =
    (await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${options.branch}`])).exitCode === 0
  const localBase = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])).exitCode === 0
  // A known host lands through the remote's base; anything else lands here, in the local branch.
  const target = host === null && localBase ? `refs/heads/${base}` : options.baseRef
  const unmerged = await count(`${target}..${options.branch}`)
  const made = (await count(`${options.startedFrom}..${options.branch}`)) > 0
  const inBase =
    made && ((await isAncestor(options.baseRef)) || (localBase && (await isAncestor(`refs/heads/${base}`))))

  let pullRequest: PullRequest | undefined
  if (host === 'github' && published && options.gh !== undefined) {
    const gh = await options.gh.signedIn(cwd)
    if (gh !== null) pullRequest = await options.gh.pullRequest(gh, cwd, options.branch)
  }
  const compareUrl = url === '' ? undefined : reviewUrl({ remoteUrl: url, branch: options.branch, baseRef: base })

  return {
    worktreeId: options.worktreeId,
    branch: options.branch,
    base,
    host,
    published,
    unmerged,
    merged: inBase || pullRequest?.state === 'merged',
    ...(compareUrl === undefined ? {} : { compareUrl }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
    readAt: (options.now ?? Date.now)(),
    ...(options.parent === undefined ? {} : { parent: options.parent })
  }
}

/** Opens a pull request with `gh` when it is signed in; otherwise answers with the page that opens one. */
export async function createPullRequest(runner: GitRunner, options: LandingOptions): Promise<WorktreePullRequest> {
  const landing = await readLanding(runner, options)
  const answer = (url: string, created: boolean, number?: number): WorktreePullRequest => ({
    worktreeId: options.worktreeId,
    url,
    ...(number === undefined ? {} : { number }),
    created
  })
  if (landing.parent !== undefined) {
    throw new GitServiceError(ErrorCode.Conflict, `Lands in ${landing.parent.name}`)
  }
  if (landing.host === null || landing.compareUrl === undefined) {
    throw new GitServiceError(ErrorCode.Conflict, `${REMOTE} is not on GitHub, GitLab or Bitbucket`)
  }
  if (!landing.published) {
    throw new GitServiceError(ErrorCode.Conflict, `${options.branch} is not on ${REMOTE}; publish it first`)
  }
  if (landing.pullRequest?.state === 'open') return answer(landing.pullRequest.url, false, landing.pullRequest.number)

  const gh = landing.host === 'github' ? await options.gh?.signedIn(options.worktreePath) : null
  if (gh === null || gh === undefined) return answer(landing.compareUrl, false)

  const made = await gh.tryRun({
    args: ['pr', 'create', '--fill', '--head', options.branch, '--base', landing.base],
    cwd: options.worktreePath,
    env: GH_ENV,
    timeoutMs: 120_000
  })
  options.gh?.forget(options.branch)
  const url = made.stdout
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('https://'))
  if (made.exitCode !== 0 || url === undefined) {
    throw new GitServiceError(ErrorCode.GitFailed, firstLine(made.stderr) || 'gh pr create failed')
  }
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  return answer(url, true, number === undefined ? undefined : Number(number))
}

export type MergeOptions = {
  worktreeId: string
  /** The project's own checkout, which must have the base branch checked out. */
  repoPath: string
  branch: string
  baseRef: string
  /** A child landing in its parent's checkout: only dirty paths it brings refuse it, and so does the parent's agent mid-turn. */
  parent?: { name: string; agentWorking: () => boolean }
  dryRun?: boolean
}

/**
 * Merges the branch into the base branch where the project's checkout has it: a fast-forward
 * when it can, else a merge commit. Refuses over uncommitted work there, and backs out of a conflict.
 */
export async function mergeIntoBase(runner: GitRunner, options: MergeOptions): Promise<WorktreeMerge> {
  assertRefShape(options.branch, 'branch')
  const into = bareRef(options.baseRef, REMOTE)
  assertRefShape(into, 'base branch')
  const cwd = options.repoPath
  const read = (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    runner.tryRun({ args, cwd, readOnly: true, timeoutMs: 30_000 })

  const head = await read(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const current = head.exitCode === 0 ? head.stdout.trim() : ''
  if (current !== into) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `${cwd} has ${current === '' ? 'a detached HEAD' : current} checked out, not ${into}`
    )
  }

  const status = await read(['status', '--porcelain=v2', '-z'])
  const brought =
    options.parent === undefined
      ? null
      : new Set((await read(['diff', '--name-only', '-z', `${into}...${options.branch}`])).stdout.split('\0'))
  const dirty = parseChangeRecords(status.stdout)
    .filter((change) => change.kind !== 'untracked' && (brought === null || brought.has(change.path)))
    .map((change) => change.path)
  const log = await read(['log', `-n${MERGE_COMMITS_SHOWN}`, '--format=%h%x1f%s', `${into}..${options.branch}`])
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [shortSha = '', subject = ''] = line.split('\x1f')
      return { shortSha, subject }
    })
  const fastForward = (await read(['merge-base', '--is-ancestor', into, options.branch])).exitCode === 0
  const plan: WorktreeMerge = {
    worktreeId: options.worktreeId,
    into,
    checkout: cwd,
    commits,
    fastForward,
    dirty,
    merged: false
  }
  if (options.dryRun) return plan

  if (dirty.length > 0) {
    const refusal =
      options.parent === undefined
        ? `${cwd} has uncommitted changes`
        : `${options.parent.name} has uncommitted changes to ${dirty.join(', ')}`
    throw new GitServiceError(ErrorCode.Conflict, refusal, { dirty })
  }
  if (options.parent?.agentWorking() === true) {
    throw new GitServiceError(ErrorCode.Conflict, `${options.parent.name}'s agent is working`)
  }
  if (commits.length === 0) throw new GitServiceError(ErrorCode.Conflict, `${into} already has ${options.branch}`)

  const merged = await runner.tryRun({
    args: ['merge', fastForward ? '--ff-only' : '--no-ff', '--no-edit', options.branch],
    cwd,
    timeoutMs: 120_000
  })
  if (merged.exitCode !== 0) {
    const unmerged = await read(['diff', '--name-only', '--diff-filter=U'])
    const conflicts = unmerged.stdout.split('\n').filter(Boolean)
    // Never leave the project's checkout mid-merge.
    await runner.tryRun({ args: ['merge', '--abort'], cwd, timeoutMs: 30_000 }).catch(() => undefined)
    throw new GitServiceError(
      ErrorCode.Conflict,
      conflicts.length > 0
        ? `${options.branch} conflicts with ${into} in ${conflicts.join(', ')}`
        : firstLine(merged.stderr) || `could not merge ${options.branch} into ${into}`,
      conflicts.length > 0 ? { conflicts } : undefined
    )
  }
  const tip = await read(['rev-parse', 'HEAD'])
  return { ...plan, merged: true, head: tip.stdout.trim() }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}
