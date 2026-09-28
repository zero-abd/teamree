// What the small marks say under the pointer: counts in words with their real refs, and the dots' states.

import { changedFiles, type AgentKind, type WorktreeStatus } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { agoLabel, SETTING_UP, TONE_LABEL, type DotTone, type SetupRun } from './agentRows'

/** `1 commit`, `2 commits`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** What a worktree's counts are measured against: `behind` the base ref, `ahead` the upstream when it has one. */
export type GitRefs = { base: string | null; upstream: string | null | undefined }

/** `base` is the worktree's own base ref (a child's parent branch) or its project's. */
export function gitRefs(status: Pick<WorktreeStatus, 'upstream'>, base: string | undefined): GitRefs {
  return { base: base ?? null, upstream: status.upstream }
}

export function behindTip(count: number, refs: GitRefs): string {
  const ref = refs.base ?? refs.upstream
  return `${plural(count, 'commit')} behind${ref ? ` ${ref}` : ''}`
}

export function aheadTip(count: number, refs: GitRefs): string {
  const commits = plural(count, 'commit')
  if (typeof refs.upstream === 'string' && refs.upstream !== refs.base)
    return `${commits} not pushed to ${refs.upstream}`
  if (refs.base === null) return refs.upstream === null ? `${commits} not pushed` : `${commits} ahead`
  return `${commits} ahead of ${refs.base}${refs.upstream === null ? ', not pushed' : ''}`
}

export function changedTip(count: number): string {
  return plural(count, 'changed file')
}

export function conflictedTip(count: number): string {
  return `${plural(count, 'file')} with conflicts`
}

/** A directory an ignore rule names counts as one entry. */
export function ignoredTip(count: number): string {
  return `${count} ignored ${count === 1 ? 'file or folder' : 'files or folders'}`
}

/** The Changes badge: what a commit would deal with. */
export function changesTip(
  status: Pick<WorktreeStatus, 'staged' | 'unstaged' | 'untracked' | 'changed' | 'conflicted'>
): string {
  const changed = changedFiles(status)
  return [status.conflicted > 0 ? conflictedTip(status.conflicted) : '', changed > 0 ? changedTip(changed) : '']
    .filter(Boolean)
    .join(' · ')
}

/** A pane tab's dot and glyph: `Claude Code · working`. */
export function paneMarkTip(agent: AgentKind | undefined, tone: DotTone | null): string {
  const name = agent === undefined ? 'Terminal' : harnessName(agent)
  return tone === null ? name : `${name} · ${TONE_LABEL[tone]}`
}

/** A setup pane's glyph: `Setting up · npm ci`, `Setup failed · exit 127`. */
export function setupTip(setup: SetupRun, tone: DotTone): string {
  if (setup.running) return setup.command === undefined ? SETTING_UP : `${SETTING_UP} · ${setup.command}`
  if (tone === 'failed') return setup.exitCode === undefined ? 'Setup failed' : `Setup failed · exit ${setup.exitCode}`
  return setup.exitCode === 0 ? 'Setup passed' : 'Setup ended'
}

/** A pane row's time slot. */
export function lastOutputTip(quietFor: number): string {
  const ago = agoLabel(quietFor)
  return ago === 'now' ? 'Last output just now' : `Last output ${ago}`
}

/** The project head's count; a folded project counts its teammates' worktrees apart. */
export function projectCountTip(count: number, theirs: number): string {
  const mine = plural(count, 'worktree')
  return theirs > 0 ? `${mine} · ${plural(theirs, 'teammate worktree')}` : mine
}

export function unpushedTip(ahead: number, upstream: string): string {
  return `${plural(ahead, 'commit')} not pushed to ${upstream}`
}

export function workingTip(count: number): string {
  return `${plural(count, 'agent')} working`
}
