import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { WorkspaceStore } from './workspaceStore'

const project: Project = { id: 'p1', name: 'teamree', path: '/repos/teamree', baseRef: 'origin/main' }

function worktree(id: string, projectId = 'p1'): Worktree {
  return {
    id,
    projectId,
    name: id,
    branch: `feature/${id}`,
    path: `/repos/teamree-${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1700000000000
  }
}

describe('workspace store', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-store-'))
    filePath = join(directory, 'state', 'workspace.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts empty when the file does not exist', async () => {
    const store = await WorkspaceStore.open(filePath)
    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
  })

  it('writes through a temp file and leaves none behind', async () => {
    const store = await WorkspaceStore.open(filePath)
    store.putProject(project)
    store.putWorktree(worktree('w1'))
    store.putLayout({ worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' })
    await store.flush()

    const written = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(written.projects).toEqual([project])
    expect(written.layouts).toEqual([
      { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }
    ])
    expect((await readdir(join(directory, 'state'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('coalesces a burst of mutations into a durable final state', async () => {
    const store = await WorkspaceStore.open(filePath)
    store.putProject(project)
    for (let index = 0; index < 25; index += 1) store.putWorktree(worktree(`w${index}`))
    await store.flush()

    const reopened = await WorkspaceStore.open(filePath)
    expect(reopened.listWorktrees('p1')).toHaveLength(25)
    expect(reopened.getProject('p1')).toEqual(project)
  })

  it('starts empty rather than throwing on a corrupt file', async () => {
    const corruptPath = join(directory, 'workspace.json')
    await writeFile(corruptPath, '{"projects": [{"id": "p1"', 'utf8')

    const store = await WorkspaceStore.open(corruptPath)

    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
    store.putProject(project)
    await store.flush()
    expect(JSON.parse(await readFile(corruptPath, 'utf8'))).toMatchObject({ projects: [project] })
  })

  it('drops rows that no longer match the entity shape and keeps the rest', async () => {
    const path = join(directory, 'workspace.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        projects: [project, { id: 'p2' }, 'garbage'],
        worktrees: [worktree('w1'), { id: 'w2', projectId: 'p1', state: 'exploded' }],
        layouts: [{ worktreeId: 'w1', root: null, focusedTerminalId: null }, { root: null }]
      }),
      'utf8'
    )

    const store = await WorkspaceStore.open(path)

    expect(store.listProjects()).toEqual([project])
    expect(store.listWorktrees().map((row) => row.id)).toEqual(['w1'])
    expect(store.getLayout('w1')).toEqual({ worktreeId: 'w1', root: null, focusedTerminalId: null })
  })

  it('removes a project together with its worktrees and layouts', async () => {
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    store.putProject(project)
    store.putWorktree(worktree('w1'))
    store.putLayout({ worktreeId: 'w1', root: null, focusedTerminalId: null })

    expect(store.removeProject('p1')).toBe(true)
    expect(store.removeProject('p1')).toBe(false)
    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
  })
})
