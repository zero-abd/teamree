// The git half of `worktree.nest`: whether a branch holds a tip, has landed, or can be replayed onto
// a new parent. A rebase that stops is aborted, so a refusal leaves the checkout as it was.

import type { Terminal } from '../../shared/entities'
import type { NestRefusal, NestRefusalCode } from '../../shared/nesting'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { parseMergeTree } from './mergePreview'
import { assertRefShape } from './repository'
import { requireCommitIdentity } from './worktreeCommit'
import { parsePorcelainV2, readOperation } from './worktreeStatus'

const WIRE_CODE: Partial<Record<NestRefusalCode, ErrorCode>> = {
  missing: ErrorCode.NotFound,
  same: ErrorCode.InvalidParams,
  teammate: ErrorCode.InvalidParams,
  project: ErrorCode.InvalidParams,
  depth: ErrorCode.ChildLimit,
  children: ErrorCode.ChildLimit
}

export function nestError(refusal: NestRefusal, extra: Record<string, unknown> = {}): GitServiceError {
  return new GitServiceError(WIRE_CODE[refusal.refusal] ?? ErrorCode.Conflict, refusal.reason, {
    refusal: refusal.refusal,
    ...extra
  })
}

/** An agent pane mid-turn: printing, or last heard starting a turn or asking for something. */
export function agentMidTurn(terminal: Terminal): boolean {
  if (!terminal.running || (terminal.agent ?? terminal.foregroundAgent) === undefined) return false
  if (terminal.busy) return true
  const said = terminal.agentEvent
  if (said !== undefined) {
    return said.event === 'UserPromptSubmit' || (said.event === 'Notification' && said.detail !== 'idle_prompt')
  }
  return terminal.titleSays !== undefined
}

type Repo = { runner: GitRunner; cwd: string }

async function exits(repo: Repo, args: string[]): Promise<number> {
  return (await repo.runner.tryRun({ args, cwd: repo.cwd, readOnly: true, timeoutMs: 60_000 })).exitCode
}

async function count(repo: Repo, args: string[]): Promise<number> {
  const read = await repo.runner.tryRun({ args: ['rev-list', '--count', ...args], cwd: repo.cwd, readOnly: true })
  return read.exitCode === 0 ? Number.parseInt(read.stdout.trim(), 10) || 0 : 0
}

export async function containsTip(repo: Repo, branch: string, tipOf: string): Promise<boolean> {
  return (await exits(repo, ['merge-base', '--is-ancestor', tipOf, branch])) === 0
}

/** Made a commit since `startedFrom`, and every commit it made is in `base`. */
export async function hasLanded(repo: Repo, branch: string, startedFrom: string, base: string): Promise<boolean> {
  if ((await count(repo, [`${startedFrom}..${branch}`])) === 0) return false
  return containsTip(repo, base, branch)
}

/** Commits `branch` has from `oldParent` that `base` lacks: what its diff gains once measured against `base`. */
export async function inheritedCommits(repo: Repo, branch: string, oldParent: string, base: string): Promise<number> {
  return (await count(repo, [branch, `^${base}`])) - (await count(repo, [branch, `^${base}`, `^${oldParent}`]))
}

export type ReplayPlan = {
  worktreePath: string
  branch: string
  /** The new parent's branch. */
  onto: string
  /** Where its own commits start: the fork point from what it was measured against. */
  from: string
}

/** Where `branch`'s own commits start, measured against `base`; `fallback` when `base` is gone. */
export async function forkPoint(repo: Repo, branch: string, base: string, fallback: string): Promise<string> {
  const read = await repo.runner.tryRun({ args: ['merge-base', branch, base], cwd: repo.cwd, readOnly: true })
  return read.exitCode === 0 ? read.stdout.trim() : fallback
}

/** Throws the first reason the replay cannot run; merges in memory, never in the checkout. */
export async function checkReplay(runner: GitRunner, plan: ReplayPlan, agentWorking: boolean): Promise<void> {
  const cwd = plan.worktreePath
  assertRefShape(plan.onto, 'parent branch')
  const refuse = (refusal: NestRefusalCode, reason: string, extra?: Record<string, unknown>): never => {
    throw nestError({ refusal, reason }, extra)
  }
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
    cwd,
    readOnly: true
  })
  const status = parsePorcelainV2(stdout)
  // Untracked files are left out as `worktree.update` leaves them: git stops by itself on one in the way.
  if (readOperation(cwd) !== undefined || status.staged + status.unstaged + status.conflicted > 0) {
    refuse('dirty', 'Uncommitted changes')
  }
  if (status.detached || status.branch !== plan.branch) refuse('dirty', `Not on ${plan.branch}`)
  if (agentWorking) refuse('agent', 'Agent is working')
  if (status.upstream !== null) refuse('published', 'Branch is published')

  const merged = await runner.tryRun({
    args: ['merge-tree', '-z', '--write-tree', '--name-only', `--merge-base=${plan.from}`, plan.onto, plan.branch],
    cwd,
    readOnly: true,
    timeoutMs: 60_000
  })
  // Above 1 is a git too old to merge in memory; the replay itself still aborts on a conflict.
  if (merged.exitCode === 1) wouldConflict(parseMergeTree(merged.stdout).conflicts)
}

/** Replays `from..branch` onto `onto` in the checkout; a stop is aborted and refused. */
export async function replay(runner: GitRunner, plan: ReplayPlan): Promise<void> {
  const cwd = plan.worktreePath
  await requireCommitIdentity(runner, cwd)
  const run = await runner.tryRun({
    args: ['rebase', '--onto', plan.onto, plan.from],
    cwd,
    // Nothing here may wait on an editor nobody can see.
    env: { GIT_EDITOR: 'true' }
  })
  if (run.exitCode === 0) return
  const listed = await runner.tryRun({
    args: ['diff', '--name-only', '--diff-filter=U', '-z'],
    cwd,
    readOnly: true
  })
  const conflicts = listed.exitCode === 0 ? [...new Set(listed.stdout.split('\0').filter(Boolean))] : []
  if (readOperation(cwd) !== undefined) await runner.run({ args: ['rebase', '--abort'], cwd })
  if (conflicts.length > 0) wouldConflict(conflicts)
  throw new GitServiceError(ErrorCode.GitFailed, firstLine(run.stderr) || `could not rebase onto ${plan.onto}`)
}

function wouldConflict(paths: string[]): never {
  const files = paths.length === 1 ? '1 file' : `${paths.length} files`
  throw nestError({ refusal: 'conflicts', reason: `Would conflict in ${files}` }, { paths })
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('hint:')) ?? ''
  )
}
