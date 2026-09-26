import { describe, expect, it } from 'vitest'
import type { Layout, Terminal, Worktree } from '../../../shared/entities'
import { fileLeaf, fileLeavesIn } from '../../../shared/filePane'
import { MAX_PEER_PATHS, PEER_TASK_CHARS } from '../../../shared/presenceExtras'
import { presenceFor } from './presence'
import type { TaskGitDetails } from './presenceDetails'

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'notes',
  branch: 'notes',
  path: '/tmp/notes',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}

const terminal = (id: string): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/tmp/notes',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0
})

describe('presenceFor', () => {
  it('lists the terminals of a worktree and skips its file panes', () => {
    const layout: Layout = {
      worktreeId: 'w1',
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [{ kind: 'leaf', terminalId: 't1' }, fileLeaf('file:1', 'NOTES.md')]
      },
      focusedTerminalId: 'file:1'
    }
    expect(fileLeavesIn(layout.root)).toHaveLength(1)

    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [terminal('t1')]
        },
        now: () => 1_000
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.id)).toEqual(['t1'])
  })

  it('sends the name a pane was given, and nothing for one never named', () => {
    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [{ ...terminal('t1'), label: 'api server' }, terminal('t2')]
        }
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.label)).toEqual(['api server', undefined])
    expect('label' in (panes[1] ?? {})).toBe(false)
  })

  // The reader names the pane; the number it was started with is a fact only the owner has.
  it('sends the number a pane was started with', () => {
    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [{ ...terminal('t1'), ordinal: 2 }, terminal('t2')]
        }
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.ordinal)).toEqual([2, undefined])
  })
})

describe('presenceFor with task details', () => {
  const source = (overrides: Partial<Worktree> = {}, details?: TaskGitDetails, terminals: Terminal[] = []) => ({
    projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
    worktrees: () => [{ ...worktree, ...overrides }],
    terminals: () => terminals,
    details: () => details
  })
  const describeOne = (options: Parameters<typeof presenceFor>[0]) =>
    presenceFor(options, 'peer', 'me', 1).projects[0]?.worktrees[0]

  it('sends the task’s first line, the parent, paths, ahead, stage and the report’s first sentence', () => {
    const sent = describeOne({
      source: source(
        {
          task: 'Add rate limits to the API\nUse a token bucket.',
          parentId: 'w0',
          report: { outcome: 'succeeded', summary: 'Added limiter. Tests pass.', paths: ['src/a.ts'], at: 5 }
        },
        { paths: ['src/limiter.ts', 'src/api.ts'], ahead: 2, clean: true }
      ),
      taskDetails: true
    })
    expect(sent).toMatchObject({
      task: 'Add rate limits to the API',
      parentId: 'w0',
      paths: ['src/limiter.ts', 'src/api.ts'],
      ahead: 2,
      stage: 'done',
      report: { outcome: 'succeeded', summary: 'Added limiter.' }
    })
    expect(sent && 'memory' in sent).toBe(false)
  })

  it('sends only v1 while Share Task Details is off', () => {
    const sent = describeOne({
      source: source({ task: 'Add rate limits', parentId: 'w0' }, { paths: ['src/a.ts'], ahead: 1, clean: true }),
      taskDetails: false
    })
    expect(Object.keys(sent ?? {}).sort()).toEqual(['branch', 'id', 'name', 'panes', 'state'])
  })

  it('cuts a 10k-path worktree to 200 paths and a long task to 200 characters', () => {
    const paths = Array.from({ length: 10_000 }, (_, index) => `src/file-${index}.ts`)
    const sent = describeOne({
      source: source({ task: 'x'.repeat(5_000) }, { paths, ahead: 0, clean: false }),
      taskDetails: true
    })
    expect(sent?.paths).toHaveLength(MAX_PEER_PATHS)
    expect(sent?.task).toHaveLength(PEER_TASK_CHARS)
  })

  it('names the stage from the panes and git', () => {
    const agent = (overrides: Partial<Terminal>): Terminal => ({ ...terminal('t1'), agent: 'claude', ...overrides })
    const stage = (terminals: Terminal[], details?: TaskGitDetails, overrides: Partial<Worktree> = {}) =>
      describeOne({ source: source(overrides, details, terminals), taskDetails: true })?.stage
    expect(stage([agent({ busy: true })])).toBe('working')
    expect(stage([agent({ screenSays: 'waiting' })])).toBe('asking')
    expect(stage([agent({})])).toBe('stopped')
    expect(stage([agent({})], { paths: ['a'], ahead: 1, clean: true })).toBe('ready')
    expect(stage([], undefined, { state: 'failed' })).toBe('failed')
    expect(stage([])).toBeUndefined()
  })

  it('carries no file contents and no scrollback, only paths', () => {
    const sent = describeOne({
      source: source({ task: 'fix it' }, { paths: ['secrets/.env'], ahead: 0, clean: false }, [terminal('t1')]),
      taskDetails: true
    })
    expect(sent?.paths).toEqual(['secrets/.env'])
    expect(sent?.panes[0] && 'data' in sent.panes[0]).toBe(false)
  })
})
