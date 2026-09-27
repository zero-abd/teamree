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

  const panesOf = (terminals: Terminal[], muted?: (terminalId: string) => boolean) =>
    presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => terminals,
          ...(muted === undefined ? {} : { muted })
        }
      },
      'peer',
      'me',
      1
    ).projects[0]?.worktrees[0]?.panes ?? []

  it('sends an asking pane as asking, with its menu and never its question', () => {
    const menu = {
      prompt: '1a2b3c4d',
      choices: [
        { label: 'Yes', keys: ['\r'] },
        { label: 'Yes, Always', keys: ['2'] },
        { label: 'No…', keys: null }
      ]
    }
    const hook = { event: 'Notification' as const, at: 1, message: 'Claude needs your permission to use Bash' }
    const [asking, working, hooked] = panesOf([
      { ...terminal('t1'), agent: 'claude', screenSays: 'waiting', screenMenu: menu },
      { ...terminal('t2'), agent: 'claude', busy: true },
      { ...terminal('t3'), agent: 'claude', agentEvent: hook }
    ])
    expect(asking).toMatchObject({ asking: true, menu })
    expect(working && ('asking' in working || 'menu' in working)).toBe(false)
    expect(hooked).toMatchObject({ asking: true })
    expect(hooked && 'menu' in hooked).toBe(false)
    expect(JSON.stringify(hooked)).not.toContain('permission')
  })

  it('sends neither for a pane whose agent has exited', () => {
    const menu = { prompt: 'ffff0000', choices: [{ label: 'Yes', keys: ['\r'] }] }
    const [exited] = panesOf([{ ...terminal('t1'), agent: 'claude', running: false, exitCode: 0, screenMenu: menu }])
    expect(exited && ('asking' in exited || 'menu' in exited)).toBe(false)
  })

  it('says which Run button started a pane, so its exit reads as the run ended', () => {
    const [dev, shell] = panesOf([{ ...terminal('t1'), run: 'dev', running: false, exitCode: 129 }, terminal('t2')])
    expect(dev).toMatchObject({ run: 'dev', exitCode: 129 })
    expect(shell && 'run' in shell).toBe(false)
  })

  it('says which panes the owner muted', () => {
    const panes = panesOf([terminal('t1'), terminal('t2')], (terminalId) => terminalId === 't1')
    expect(panes.map((pane) => pane.muted)).toEqual([true, undefined])
    expect('muted' in (panes[1] ?? {})).toBe(false)
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
    // A live agent at its prompt is not stopped; the owner's pane reading says what it is.
    expect(stage([agent({})])).toBeUndefined()
    expect(stage([agent({ titleSays: 'working' })])).toBe('working')
    expect(stage([agent({ agentEvent: { event: 'UserPromptSubmit', at: 1 } })])).toBe('working')
    expect(stage([agent({})], { paths: ['a'], ahead: 1, clean: true })).toBe('ready')
    expect(stage([], undefined, { state: 'failed' })).toBe('failed')
    expect(stage([])).toBeUndefined()
  })

  it('sends each pane as its owner reads it', () => {
    const agent = (id: string, overrides: Partial<Terminal>): Terminal => ({
      ...terminal(id),
      agent: 'claude',
      ...overrides
    })
    const sent = describeOne({
      source: source({}, undefined, [
        agent('t1', { agentEvent: { event: 'UserPromptSubmit', at: 1 } }),
        agent('t2', { agentEvent: { event: 'Stop', at: 1 } }),
        agent('t3', { running: false, exitCode: 0, tookTurn: false })
      ]),
      taskDetails: false
    })
    expect(sent?.panes.map((pane) => pane.activity)).toEqual(['working', 'quiet', 'stopped'])
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
