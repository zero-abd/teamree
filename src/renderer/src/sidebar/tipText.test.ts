import { describe, expect, it } from 'vitest'
import type { WorktreeStatus } from '@shared/entities'
import {
  aheadTip,
  behindTip,
  changedTip,
  changesTip,
  conflictedTip,
  gitRefs,
  ignoredTip,
  paneMarkTip,
  plural,
  projectCountTip,
  unpushedTip,
  workingTip
} from './tipText'

const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'fix-login',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...over
})

describe('plural', () => {
  it('says one and many', () => {
    expect(plural(1, 'commit')).toBe('1 commit')
    expect(plural(2, 'commit')).toBe('2 commits')
    expect(plural(0, 'file')).toBe('0 files')
  })
})

describe('git counts', () => {
  it('names the base ref a count is behind', () => {
    const refs = gitRefs(status({ upstream: 'origin/fix-login' }), 'origin/master')
    expect(behindTip(48, refs)).toBe('48 commits behind origin/master')
    expect(behindTip(1, refs)).toBe('1 commit behind origin/master')
  })

  it('names the upstream when there is no base ref, and says so plainly when there is neither', () => {
    expect(behindTip(3, gitRefs(status({ upstream: 'origin/fix-login' }), undefined))).toBe(
      '3 commits behind origin/fix-login'
    )
    expect(behindTip(3, gitRefs(status(), undefined))).toBe('3 commits behind')
  })

  it('names the parent branch a child task is behind', () => {
    expect(behindTip(4, gitRefs(status(), 'task/parent'))).toBe('4 commits behind task/parent')
  })

  it('says ahead of the upstream is not pushed, and ahead of the base otherwise', () => {
    expect(aheadTip(2, gitRefs(status({ upstream: 'origin/fix-login' }), 'origin/main'))).toBe(
      '2 commits not pushed to origin/fix-login'
    )
    expect(aheadTip(1, gitRefs(status({ upstream: null }), 'origin/main'))).toBe(
      '1 commit ahead of origin/main, not pushed'
    )
    expect(aheadTip(5, gitRefs(status({ upstream: 'origin/main' }), 'origin/main'))).toBe(
      '5 commits ahead of origin/main'
    )
    expect(aheadTip(5, gitRefs(status({ upstream: undefined }), undefined))).toBe('5 commits ahead')
  })

  it('counts files, conflicts and ignored entries', () => {
    expect(changedTip(115)).toBe('115 changed files')
    expect(changedTip(1)).toBe('1 changed file')
    expect(conflictedTip(2)).toBe('2 files with conflicts')
    expect(conflictedTip(1)).toBe('1 file with conflicts')
    expect(ignoredTip(10)).toBe('10 ignored files or folders')
    expect(ignoredTip(1)).toBe('1 ignored file or folder')
  })

  it('says what the Changes badge counts', () => {
    expect(changesTip(status({ changed: 115 }))).toBe('115 changed files')
    expect(changesTip(status({ changed: 3, conflicted: 1 }))).toBe('1 file with conflicts · 3 changed files')
  })
})

describe('marks', () => {
  it('names the harness and its state on a pane tab', () => {
    expect(paneMarkTip('claude', 'working')).toBe('Claude Code · working')
    expect(paneMarkTip(undefined, 'idle')).toBe('Terminal · idle')
    expect(paneMarkTip('codex', null)).toBe('Codex')
  })

  it('counts a project’s worktrees and its teammates’ apart', () => {
    expect(projectCountTip(1, 0)).toBe('1 worktree')
    expect(projectCountTip(3, 2)).toBe('3 worktrees · 2 teammate worktrees')
  })

  it('says a base with local commits is not pushed', () => {
    expect(unpushedTip(2, 'origin/main')).toBe('2 commits not pushed to origin/main')
    expect(unpushedTip(1, 'origin/main')).toBe('1 commit not pushed to origin/main')
  })

  it('counts working agents', () => {
    expect(workingTip(1)).toBe('1 agent working')
    expect(workingTip(2)).toBe('2 agents working')
  })
})
