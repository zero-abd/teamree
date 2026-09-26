import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Terminal, Worktree } from '../../shared/entities.js'
import { runCli } from '../run.js'
import { startStubRuntime, StubError } from '../stub-runtime.js'
import { whoami, whoamiText } from './whoami.js'

const PROJECTS: Project[] = [{ id: 'p_api', name: 'api', path: '/repos/api', baseRef: 'origin/main' } as Project]

function worktree(id: string, parentId?: string): Worktree {
  return {
    id,
    projectId: 'p_api',
    name: id.replace('wt_', ''),
    branch: id.replace('wt_', 'b-'),
    path: `/repos/api-${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1,
    ...(parentId === undefined ? {} : { parentId })
  }
}

const WORKTREES = [worktree('wt_top'), worktree('wt_mid', 'wt_top'), worktree('wt_leaf', 'wt_mid')]
const TERMINALS = [
  {
    id: 'term_7',
    worktreeId: 'wt_leaf',
    title: 'claude',
    agent: 'claude',
    label: 'leaf',
    cwd: '/repos/api-wt_leaf',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true
  } as Terminal
]
const PANE = { TEAMREE_TERMINAL_ID: 'term_7', TEAMREE_WORKTREE_ID: 'wt_leaf', TEAMREE_PROJECT_ID: 'p_api' }

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('whoami', () => {
  it('names the pane, its worktree, project and every parent, nearest first', () => {
    const me = whoami({ env: PANE, cwd: '/' }, { worktrees: WORKTREES, projects: PROJECTS, terminals: TERMINALS })
    expect(me).toEqual({
      terminal: { id: 'term_7', title: 'claude', label: 'leaf', agent: 'claude' },
      worktree: { id: 'wt_leaf', name: 'leaf', branch: 'b-leaf', path: '/repos/api-wt_leaf' },
      project: { id: 'p_api', name: 'api' },
      parents: [
        { id: 'wt_mid', name: 'mid', branch: 'b-mid' },
        { id: 'wt_top', name: 'top', branch: 'b-top' }
      ]
    })
    expect(whoamiText(me)).toBe(
      [
        'pane:     term_7  leaf',
        'worktree: leaf  wt_leaf',
        'branch:   b-leaf',
        'project:  api  p_api',
        'parents:  mid (b-mid) < top (b-top)',
        'path:     /repos/api-wt_leaf'
      ].join('\n')
    )
  })

  it('stops at a parent chain that loops', () => {
    const looped = [worktree('wt_a', 'wt_b'), worktree('wt_b', 'wt_a')]
    const me = whoami(
      { env: { TEAMREE_WORKTREE_ID: 'wt_a' }, cwd: '/' },
      { worktrees: looped, projects: [], terminals: [] }
    )
    expect(me.parents.map((parent) => parent.id)).toEqual(['wt_b'])
    expect(me.terminal).toBeNull()
  })

  it('reaches the app named by the pane, with no discovery file anywhere', async () => {
    const stub = await startStubRuntime((method) => {
      if (method === 'worktree.list') return WORKTREES
      if (method === 'project.list') return PROJECTS
      if (method === 'terminal.list') return TERMINALS
      throw new StubError('unknown_method', method)
    })
    cleanups.push(() => stub.close())
    const empty = mkdtempSync(join(tmpdir(), 'teamree-whoami-'))
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }))

    let out = ''
    const code = await runCli(['whoami', '--json'], {
      streams: { out: (text) => (out += text), err: () => {} },
      env: { ...PANE, TEAMREE_ENDPOINT: stub.endpoint, TEAMREE_USER_DATA_DIR: empty },
      cwd: '/'
    })
    expect(code).toBe(0)
    const document = JSON.parse(out) as { ok: boolean; data: { terminal: { id: string }; parents: unknown[] } }
    expect(document.data.terminal.id).toBe('term_7')
    expect(document.data.parents).toHaveLength(2)
  })
})
