// Landing a parent's children from its panel, against real git: in tree order, each committed
// first under its own message, and stopping at the first that would conflict.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'
import { GitService } from '../../../../main/git/gitService'
import { createGitHandlers, type GitHandlers } from '../../../../main/git/handlers'
import { createTempRepo, type TempRepo } from '../../../../main/git/testRepository'

const live = vi.hoisted(() => ({ handlers: null as Record<string, (params: unknown) => Promise<unknown>> | null }))

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => {
      const handler = live.handlers?.[method]
      return handler === undefined ? Promise.reject(new Error(`not wired: ${method}`)) : handler(params)
    },
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { useChildren } = await import('./childrenStore')
const { useCommitDrafts } = await import('./commitMessage')

const INITIAL = useWorkspaceStore.getState()

let repo: TempRepo
let service: GitService
let parent: Worktree

beforeEach(async () => {
  repo = await createTempRepo()
  service = new GitService({ worktreesRoot: repo.worktreesRoot })
  const handlers: GitHandlers = createGitHandlers(service)
  live.handlers = handlers as unknown as Record<string, (params: unknown) => Promise<unknown>>
  await repo.write('money.js', 'export const tax = 0\n')
  await repo.commit('money')
  const project = await service.addProject({ path: repo.repoPath })
  parent = await ready({ projectId: project.id, name: 'Checkout' })
  useWorkspaceStore.setState({ ...INITIAL, worktrees: [parent], projects: [project] }, true)
  useChildren.setState({ merging: {}, stopped: {}, skipped: {}, reveal: null })
  useCommitDrafts.setState({ drafts: {} })
})

afterEach(async () => {
  live.handlers = null
  await service.dispose()
  await repo.cleanup()
})

async function ready(params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree(params)).id)
  if (settled.state !== 'ready') throw new Error(settled.error)
  return settled
}

/** A child of the parent that commits `files`, reported done with `summary`. */
async function child(name: string, files: Record<string, string>, summary = `${name} done`): Promise<Worktree> {
  const made = await ready({ projectId: parent.projectId, name, parentId: parent.id })
  for (const [path, content] of Object.entries(files)) await repo.write(path, content, made.path)
  await repo.commit(name, made.path)
  const reported: Worktree = { ...made, report: { outcome: 'succeeded', summary, paths: [], at: 0 } }
  useWorkspaceStore.setState((state) => ({ worktrees: [...state.worktrees, reported] }))
  return reported
}

const parentLog = (): Promise<string> => repo.git(['log', '--format=%s', '--first-parent'], parent.path)

describe('landing children', () => {
  it('merges one child into its parent, not into main', async () => {
    const search = await child('search', { 'search.js': 'search\n' })

    expect(await useChildren.getState().mergeChildren(parent.id, [search.id])).toBe(true)

    expect(await repo.git(['log', '--format=%s', '-1'], parent.path)).toBe('search')
    expect(await repo.git(['log', '--format=%s', 'main'])).not.toContain('search')
    expect(useChildren.getState().merging[parent.id]).toBeUndefined()
    expect(useChildren.getState().stopped[parent.id]).toBeUndefined()
  })

  it('commits a child’s uncommitted work under its suggested message first', async () => {
    const search = await child('search', { 'search.js': 'search\n' }, 'Search ranks by recency')
    await repo.write('rank.js', 'rank\n', search.path)

    expect(await useChildren.getState().mergeChildren(parent.id, [search.id])).toBe(true)

    expect(await repo.git(['show', '--name-only', '--format=%s', 'HEAD'], parent.path)).toBe(
      'Search ranks by recency\n\nrank.js'
    )
  })

  it('lands them in the order given and stops at the first that conflicts', async () => {
    const cart = await child('cart totals', { 'money.js': 'export const tax = 0.2\n', 'cart.js': 'cart\n' })
    const search = await child('search', { 'search.js': 'search\n' })
    const payment = await child('payment', { 'money.js': 'export const tax = 0.25\n' })
    const notes = await child('notes', { 'notes.md': 'notes\n' })

    expect(await useChildren.getState().mergeChildren(parent.id, [cart.id, search.id, payment.id, notes.id])).toBe(
      false
    )

    const landed = await parentLog()
    expect(landed).toContain('cart totals')
    expect(landed).toContain('search')
    expect(landed.indexOf('search')).toBeLessThan(landed.indexOf('cart totals'))
    expect(landed).not.toContain('payment')
    expect(landed).not.toContain('notes')
    const stop = useChildren.getState().stopped[parent.id]
    expect(stop).toMatchObject({ worktreeId: payment.id, conflicts: ['money.js'] })
    // Never left mid-merge.
    expect(await repo.git(['status', '--porcelain'], parent.path)).toBe('')
    expect(useChildren.getState().merging[parent.id]).toBeUndefined()
  })

  it('a later run clears the last stop', async () => {
    const search = await child('search', { 'search.js': 'search\n' })
    useChildren.setState({ stopped: { [parent.id]: { worktreeId: 'x', error: 'old', conflicts: [] } } })

    await useChildren.getState().mergeChildren(parent.id, [search.id])

    expect(useChildren.getState().stopped[parent.id]).toBeUndefined()
  })

  it('keeps what a run left out for a clash, until the next run', async () => {
    const held = [{ worktreeId: 'pay', title: 'Payment', clashesWith: 'Cart totals' }]
    await useChildren.getState().mergeChildren(parent.id, [], held)
    expect(useChildren.getState().skipped[parent.id]).toEqual(held)

    await useChildren.getState().mergeChildren(parent.id, [])
    expect(useChildren.getState().skipped[parent.id]).toBeUndefined()
  })
})
