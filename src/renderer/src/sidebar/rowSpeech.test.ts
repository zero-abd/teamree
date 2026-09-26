import { describe, expect, it } from 'vitest'
import type { WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import type { AgentRow } from './agentRows'
import type { OverlapChip } from './overlapChip'
import { boardRowSpeech, paneRowSpeech, rowSpeech, taskRowSpeech } from './rowSpeech'

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'b',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

const preview = (overrides: Partial<WorktreeMergePreview>): WorktreeMergePreview => ({
  worktreeId: 'w1',
  baseRef: 'origin/main',
  state: 'clean',
  ahead: 1,
  conflicts: [],
  readAt: 0,
  ...overrides
})

const pane = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  terminalId: 't1',
  agent: 'claude',
  label: 'Claude Code',
  text: '',
  activity: 'working',
  quietFor: 0,
  evidence: null,
  ...overrides
})

describe('what a worktree row says', () => {
  it('says nothing for a quiet, clean row', () => {
    expect(rowSpeech({ status: status() })).toBe('')
  })

  it('puts the state first, with the question an asking row shows', () => {
    expect(rowSpeech({ tone: 'waiting', question: 'Allow command?' })).toBe('asking: Allow command?')
    expect(rowSpeech({ tone: 'waiting' })).toBe('asking')
    expect(rowSpeech({ tone: 'working' })).toBe('working')
    expect(rowSpeech({ tone: 'done' })).toBe('finished')
    expect(rowSpeech({ tone: 'failed', from: 'payment' })).toBe('failed in payment')
  })

  it('reads the git chips as words joined by commas', () => {
    expect(rowSpeech({ status: status({ ahead: 1, behind: 1 }), child: true })).toBe('1 ahead, 1 behind parent')
    expect(rowSpeech({ status: status({ ahead: 2, unstaged: 1, untracked: 2 }) })).toBe('2 ahead, 3 uncommitted')
    expect(rowSpeech({ status: status({ conflicted: 1 }) })).toBe('1 conflicted')
    expect(rowSpeech({ status: status({ ahead: 1 }), ignored: 4 })).toBe('1 ahead, 4 ignored')
    expect(rowSpeech({ tone: 'working', branch: 'ada/pager', status: status({ ahead: 1 }) })).toBe(
      'working, branch ada/pager, 1 ahead'
    )
  })

  it('names what a merge would conflict on, by file', () => {
    const conflicts = preview({ state: 'conflicts', baseRef: 'search-page', conflicts: ['src/server.js'] })
    expect(rowSpeech({ merge: conflicts })).toBe('would conflict with search-page in server.js')
    const many = preview({ state: 'conflicts', conflicts: ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts'] })
    expect(rowSpeech({ merge: many })).toBe('would conflict with origin/main in 1.ts, 2.ts, 3.ts and 1 more')
    expect(rowSpeech({ merge: preview({ state: 'clean' }) })).toBe('merges cleanly')
    expect(rowSpeech({ merge: preview({ state: 'nothingToMerge' }) })).toBe('')
  })

  it('reads an overlap chip by who and which file', () => {
    const chip: OverlapChip = {
      tone: 'conflict',
      label: 'server.js',
      title: '',
      entries: [{ path: 'src/server.js', with: { worktreeId: 'w2' }, name: 'search page', kind: 'conflict' }]
    }
    expect(rowSpeech({ overlap: chip })).toBe('would conflict with search page in server.js')
    const overlap: OverlapChip = {
      ...chip,
      tone: 'overlap',
      label: '2 files',
      entries: [{ path: 'a.ts', with: { worktreeId: 'w2' }, name: 'filters', kind: 'overlap' }]
    }
    expect(rowSpeech({ overlap })).toBe('overlaps filters in 2 files')
  })

  it('says the whole of a busy row in the order the chips are drawn', () => {
    expect(
      rowSpeech({
        tone: 'waiting',
        question: 'Allow command?',
        unread: true,
        status: status({ ahead: 2, unstaged: 1 }),
        pull: { number: 42, url: 'u', state: 'open' },
        issue: 7,
        ports: [5173],
        tests: 'failed',
        claims: ['src/api/**'],
        tally: { done: 1, total: 2 },
        handoff: 'Handed to ana'
      })
    ).toBe(
      'asking: Allow command?, unread, 2 ahead, 1 uncommitted, PR 42, issue 7, port 5173, tests failed, ' +
        'claims src/api/**, 1 of 2 children done, handed to ana'
    )
  })

  it('reads a pull request by its state, review and worst checks, as its chip does', () => {
    const pull = { number: 42, url: 'u', state: 'open' as const }
    const checks = (passing: number, failing: number, pending: number) => ({ passing, failing, pending, list: [] })
    expect(rowSpeech({ pull: { ...pull, checks: checks(3, 2, 1) } })).toBe('PR 42, 2 checks failing')
    expect(rowSpeech({ pull: { ...pull, checks: checks(3, 0, 1) } })).toBe('PR 42, 1 check pending')
    expect(rowSpeech({ pull: { ...pull, checks: checks(3, 0, 0) } })).toBe('PR 42, 3 checks passing')
    expect(rowSpeech({ pull: { ...pull, draft: true, review: 'changes' } })).toBe('PR 42 draft, changes requested')
    expect(rowSpeech({ pull: { ...pull, state: 'closed', checks: checks(0, 1, 0) } })).toBe('PR 42 closed')
  })

  it('says merged or landed instead of what a merge would do', () => {
    expect(rowSpeech({ landed: 'merged', merge: preview({ state: 'clean' }) })).toBe('merged')
    expect(rowSpeech({ landed: 'landed' })).toBe('landed')
  })

  it('lists ports, and a report when the row shows one', () => {
    expect(rowSpeech({ ports: [5173, 3000] })).toBe('ports 5173, 3000')
    expect(rowSpeech({ report: '✓ Cart totals include tax.' })).toBe('reported: Cart totals include tax.')
    expect(rowSpeech({ report: '✗ Could not reproduce.' })).toBe('reported failure: Could not reproduce.')
  })

  it('says a row that is not a checkout yet, or any more', () => {
    expect(rowSpeech({ lifecycle: 'creating' })).toBe('creating')
    expect(rowSpeech({ lifecycle: 'missing' })).toBe('missing')
    expect(rowSpeech({ lifecycle: 'failed', report: null })).toBe('failed')
  })
})

describe('what a pane row says', () => {
  it('names the pane, then its state and the line it shows', () => {
    expect(paneRowSpeech(pane({ activity: 'waiting', evidence: 'Allow command?' }))).toBe(
      'Claude Code, asking: Allow command?'
    )
    expect(paneRowSpeech(pane({ activity: 'working', evidence: 'Reading files' }))).toBe(
      'Claude Code, working: Reading files'
    )
    expect(paneRowSpeech(pane({ agent: undefined, label: 'zsh', activity: 'quiet' }))).toBe('zsh, idle')
  })

  it('adds unread, who is watching, and muted', () => {
    expect(paneRowSpeech(pane(), { unread: true, hands: 'ana is watching', muted: true })).toBe(
      'Claude Code, working, unread, ana is watching, muted'
    )
  })

  it('says it once where the board repeats the worktree', () => {
    expect(boardRowSpeech({ ...pane({ activity: 'failed' }), worktreeName: 'fix login' })).toBe(
      'Claude Code, fix login, failed'
    )
    expect(boardRowSpeech({ ...pane({ label: 'fix login' }), worktreeName: 'fix login' })).toBe('fix login, working')
  })
})

describe('what a task row on the board says', () => {
  it('reads each column as words', () => {
    expect(
      taskRowSpeech({
        title: 'checkout',
        stage: 'asking',
        tally: { done: 2, total: 2 },
        panes: [
          { label: 'checkout', tone: 'waiting' },
          { label: 'Claude Code', tone: 'waiting' }
        ],
        added: 12,
        removed: 3,
        ahead: 1,
        tokens: '12k tok',
        age: '5m'
      })
    ).toBe('checkout, asking, 2 of 2 children done, Claude Code asking, 12 added, 3 removed, 1 ahead, 12k tok, 5m old')
  })
})
