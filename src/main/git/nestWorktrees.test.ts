// Nesting an existing worktree under another against a real repository: a branch holding the
// parent's tip just moves, anything else needs an explicit, clean rebase, and a refusal changes nothing.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import type { WorktreeNest } from '../../shared/nesting'
import { ErrorCode } from '../../shared/protocol'
import { MAX_OPEN_CHILDREN } from '../../shared/tasks'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry, WINDOW_CONNECTION_PREFIX } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { WorkspaceStore } from '../store/workspaceStore'
import { GitServiceError } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { GitService, type GitEvent, type GitServiceOptions } from './gitService'
import { registerGitHandlers } from './handlers'
import { createTempRepo, type TempRepo } from './testRepository'
import { readOperation } from './worktreeStatus'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Setup = { repo: TempRepo; service: GitService; project: Project; events: GitEvent[] }

async function setup(options: GitServiceOptions & { remote?: boolean } = {}): Promise<Setup> {
  const { remote, ...rest } = options
  const repo = await createTempRepo({ withRemote: remote === true })
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...rest })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const events: GitEvent[] = []
  service.events.on((event) => events.push(event))
  return { repo, service, project, events }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const pending = await service.createWorktree(params)
  const settled = await service.whenSettled(pending.id)
  if (settled.state !== 'ready') throw new Error(`"${params.name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

async function rejection(promise: Promise<unknown>): Promise<GitServiceError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GitServiceError)
    return error as GitServiceError
  }
  throw new Error('expected the promise to reject')
}

const refusalOf = (error: GitServiceError): unknown => (error.data as { refusal?: unknown } | undefined)?.refusal

/** A parent with one commit, and a top-level worktree off main with its own commit on another file. */
async function diverged(s: Setup, file = 'b.txt'): Promise<{ parent: Worktree; other: Worktree }> {
  const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
  await s.repo.write('auth.txt', 'parent\n', parent.path)
  await s.repo.commit('parent work', parent.path)
  const other = await ready(s.service, { projectId: s.project.id, name: 'Docs' })
  await s.repo.write(file, 'other\n', other.path)
  await s.repo.commit('other work', other.path)
  return { parent, other }
}

/** Everything a failed nest must leave as it was: the record, the tip, the files and git's own state. */
async function snapshot(s: Setup, worktree: Worktree): Promise<unknown> {
  return {
    record: await s.service.getWorktree({ worktreeId: worktree.id }),
    head: await s.repo.git(['rev-parse', 'HEAD'], worktree.path),
    branch: await s.repo.git(['rev-parse', worktree.branch]),
    status: await s.repo.git(['status', '--porcelain=v1', '--untracked-files=all'], worktree.path),
    operation: readOperation(worktree.path) ?? null
  }
}

describe('nesting a worktree whose branch already holds the parent tip', () => {
  it('re-points it without touching git, persists it and announces it', async () => {
    const s = await setup()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
    await s.repo.write('auth.txt', 'parent\n', parent.path)
    await s.repo.commit('parent work', parent.path)
    const other = await ready(s.service, { projectId: s.project.id, name: 'Tests', startedFrom: parent.branch })
    await s.repo.write('tests.txt', 'tests\n', other.path)
    await s.repo.commit('tests', other.path)
    const head = await s.repo.git(['rev-parse', 'HEAD'], other.path)
    s.events.length = 0

    const result = await s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id })

    expect(result.change).toBe('nest')
    expect(result.worktree).toMatchObject({ parentId: parent.id, baseRef: parent.branch })
    expect(await s.service.getWorktree({ worktreeId: other.id })).toEqual(result.worktree)
    expect(await s.repo.git(['rev-parse', 'HEAD'], other.path)).toBe(head)
    expect(s.events).toEqual([{ type: 'worktree.updated', worktree: result.worktree }])
    const log = await s.service.worktreeLog({ worktreeId: other.id })
    expect(log.commits.map((commit) => commit.subject)).toEqual(['tests'])
  })

  it('answers a dry run without changing anything', async () => {
    const s = await setup()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
    const other = await ready(s.service, { projectId: s.project.id, name: 'Tests' })
    s.events.length = 0

    const result = await s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, dryRun: true })

    expect(result).toMatchObject({ change: 'nest', dryRun: true, worktree: { parentId: parent.id } })
    expect((await s.service.getWorktree({ worktreeId: other.id })).parentId).toBeUndefined()
    expect(s.events).toEqual([])
  })

  it('keeps the new parent across a restart', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const file = path.join(repo.base, 'workspace.json')
    const store = await WorkspaceStore.open(file)
    const service = new GitService({ worktreesRoot: repo.worktreesRoot, store })
    services.push(service)
    const project = await service.addProject({ path: repo.repoPath })
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const other = await ready(service, { projectId: project.id, name: 'Tests' })
    await service.nestWorktree({ worktreeId: other.id, parentId: parent.id })
    await service.dispose()
    await store.flush()

    const saved = JSON.parse(await readFile(file, 'utf8')) as { worktrees: Worktree[] }
    expect(saved.worktrees.find((row) => row.id === other.id)).toMatchObject({
      parentId: parent.id,
      baseRef: parent.branch
    })
    const again = new GitService({ worktreesRoot: repo.worktreesRoot, store: await WorkspaceStore.open(file) })
    services.push(again)
    again.reviveRestoredRecords()
    expect((await again.getWorktree({ worktreeId: other.id })).parentId).toBe(parent.id)
  })
})

describe('nesting a worktree that lacks the parent tip', () => {
  it('is refused without rebase, and a dry run says a rebase would do', async () => {
    const s = await setup()
    const { parent, other } = await diverged(s)
    const before = await snapshot(s, other)

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id }))
    expect(refusalOf(refused)).toBe('needsRebase')
    expect(refused.message).toBe('Needs a rebase onto rework-auth')
    const dry = await s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, dryRun: true })
    expect(dry.change).toBe('rebase')
    expect(await snapshot(s, other)).toEqual(before)
  })

  it("with rebase replays only its own commits onto the parent's tip", async () => {
    const s = await setup()
    const { parent, other } = await diverged(s)
    const parentTip = await s.repo.git(['rev-parse', 'HEAD'], parent.path)

    const result = await s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true })

    expect(result.change).toBe('rebase')
    expect(result.worktree).toMatchObject({ parentId: parent.id, baseRef: parent.branch, startedFrom: parentTip })
    expect(await s.repo.git(['rev-parse', 'HEAD~1'], other.path)).toBe(parentTip)
    const log = await s.service.worktreeLog({ worktreeId: other.id })
    expect(log.commits.map((commit) => commit.subject)).toEqual(['other work'])
  })

  it('refuses uncommitted changes and leaves everything as it was', async () => {
    const s = await setup()
    const { parent, other } = await diverged(s)
    await s.repo.write('b.txt', 'edited\n', other.path)
    const before = await snapshot(s, other)

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true }))
    expect(refused.message).toBe('Uncommitted changes')
    expect(refusalOf(refused)).toBe('dirty')
    expect(await snapshot(s, other)).toEqual(before)
  })

  it('refuses while its agent is working', async () => {
    let working = true
    const s = await setup({ agentWorking: () => working })
    const { parent, other } = await diverged(s)

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true }))
    expect(refused.message).toBe('Agent is working')
    expect(refusalOf(refused)).toBe('agent')
    working = false
    expect((await s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true })).change).toBe(
      'rebase'
    )
  })

  it('refuses a rebase that would conflict, before touching the checkout', async () => {
    const s = await setup()
    const { parent, other } = await diverged(s, 'auth.txt')
    const before = await snapshot(s, other)

    for (const dryRun of [true, false]) {
      const refused = await rejection(
        s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true, dryRun })
      )
      expect(refused.message).toBe('Would conflict in 1 file')
      expect(refused.data).toEqual({ refusal: 'conflicts', paths: ['auth.txt'] })
    }
    expect(await snapshot(s, other)).toEqual(before)
  })

  it('aborts a rebase that stops on a conflict, leaving the checkout byte for byte', async () => {
    // A git without `merge-tree --write-tree`: the conflict is found by the rebase itself.
    const real = createGitRunner()
    const runner: GitRunner = {
      binary: real.binary,
      run: (run) => real.run(run),
      tryRun: (run) =>
        run.args[0] === 'merge-tree'
          ? Promise.resolve({ exitCode: 129, stdout: '', stderr: 'usage: git merge-tree <base-tree> <b1> <b2>' })
          : real.tryRun(run)
    }
    const s = await setup({ runner })
    const { parent, other } = await diverged(s, 'auth.txt')
    const bytes = await readFile(path.join(other.path, 'auth.txt'))
    const before = await snapshot(s, other)

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true }))

    expect(refused.message).toBe('Would conflict in 1 file')
    expect(await snapshot(s, other)).toEqual(before)
    expect(await readFile(path.join(other.path, 'auth.txt'))).toEqual(bytes)
  })

  it('refuses a rebase that would strand its own children', async () => {
    const s = await setup()
    const { parent, other } = await diverged(s)
    await ready(s.service, { projectId: s.project.id, name: 'Docs images', parentId: other.id })

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true }))
    expect(refusalOf(refused)).toBe('hasChildren')
    expect(refused.message).toBe('Has 1 child')
  })

  it('refuses to rewrite a published branch', async () => {
    const s = await setup({ remote: true })
    const { parent, other } = await diverged(s)
    await s.repo.git(['push', '-u', 'origin', other.branch], other.path)

    const refused = await rejection(s.service.nestWorktree({ worktreeId: other.id, parentId: parent.id, rebase: true }))
    expect(refusalOf(refused)).toBe('published')
  })
})

describe('what nesting refuses', () => {
  it('a cycle, itself, another project, a teammate, a removed worktree and a landed one', async () => {
    const s = await setup()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
    const child = await ready(s.service, { projectId: s.project.id, name: 'migration', parentId: parent.id })
    const nest = (worktreeId: string, parentId: string | null): Promise<WorktreeNest> =>
      s.service.nestWorktree({ worktreeId, parentId })

    const cycle = await rejection(nest(parent.id, child.id))
    expect([cycle.code, refusalOf(cycle), cycle.message]).toEqual([
      ErrorCode.Conflict,
      'cycle',
      'migration is under Rework auth'
    ])
    expect(refusalOf(await rejection(nest(parent.id, parent.id)))).toBe('same')
    expect(refusalOf(await rejection(nest(parent.id, 'peer:abcdef:w1')))).toBe('teammate')
    const gone = await rejection(nest('nope', parent.id))
    expect([gone.code, refusalOf(gone)]).toEqual([ErrorCode.NotFound, 'missing'])

    const second = await createTempRepo()
    repos.push(second)
    const elsewhere = await s.service.addProject({ path: second.repoPath, name: 'elsewhere' })
    const foreign = await ready(s.service, { projectId: elsewhere.id, name: 'Elsewhere' })
    expect(refusalOf(await rejection(nest(foreign.id, parent.id)))).toBe('project')

    // Landed: made a commit, and main has it.
    const landed = await ready(s.service, { projectId: s.project.id, name: 'Shipped' })
    await s.repo.write('shipped.txt', 'done\n', landed.path)
    await s.repo.commit('shipped', landed.path)
    await s.repo.git(['merge', '--ff-only', landed.branch])
    const refused = await rejection(nest(landed.id, parent.id))
    expect([refusalOf(refused), refused.message]).toEqual(['landed', 'Shipped has landed'])
    expect(refusalOf(await rejection(nest(child.id, landed.id)))).toBe('landed')
  })

  it('a move to where it already is changes nothing', async () => {
    const s = await setup()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
    const child = await ready(s.service, { projectId: s.project.id, name: 'migration', parentId: parent.id })
    s.events.length = 0
    expect((await s.service.nestWorktree({ worktreeId: child.id, parentId: parent.id })).change).toBe('none')
    expect((await s.service.nestWorktree({ worktreeId: parent.id, parentId: null })).change).toBe('none')
    expect(s.events).toEqual([])
  })
})

describe('un-nesting to the top level', () => {
  it("counts the parent's commits a dry run would add to the diff, then clears parent and base", async () => {
    const s = await setup()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth' })
    for (const name of ['one', 'two']) {
      await s.repo.write(`${name}.txt`, `${name}\n`, parent.path)
      await s.repo.commit(name, parent.path)
    }
    const child = await ready(s.service, { projectId: s.project.id, name: 'migration', parentId: parent.id })
    await s.repo.write('m.sql', 'm\n', child.path)
    await s.repo.commit('migration', child.path)
    const head = await s.repo.git(['rev-parse', 'HEAD'], child.path)

    const dry = await s.service.nestWorktree({ worktreeId: child.id, parentId: null, dryRun: true })
    expect(dry).toMatchObject({ change: 'unnest', dryRun: true, inherited: 2 })
    expect((await s.service.getWorktree({ worktreeId: child.id })).parentId).toBe(parent.id)

    s.events.length = 0
    const done = await s.service.nestWorktree({ worktreeId: child.id, parentId: null })
    expect(done.change).toBe('unnest')
    expect(done.worktree.parentId).toBeUndefined()
    expect(done.worktree.baseRef).toBeUndefined()
    expect(s.events).toEqual([{ type: 'worktree.updated', worktree: done.worktree }])
    expect(await s.repo.git(['rev-parse', 'HEAD'], child.path)).toBe(head)
    const log = await s.service.worktreeLog({ worktreeId: child.id })
    expect(log.commits.map((commit) => commit.subject)).toEqual(['migration', 'two', 'one'])
  })
})

describe('limits over the dispatcher', () => {
  async function wire(): Promise<{
    s: Setup
    call: (connectionId: string, params: Record<string, unknown>) => Promise<WorktreeNest>
  }> {
    const s = await setup()
    const store = await WorkspaceStore.open(path.join(s.repo.base, 'unused.json'))
    const registry = new MethodRegistry(
      createRuntimeContext({ version: '0.0.0-test', store, subscriptions: new SubscriptionHub() })
    )
    registerGitHandlers(registry, s.service)
    const dispatch = createDispatcher(registry)
    let counter = 0
    const call = async (connectionId: string, params: Record<string, unknown>): Promise<WorktreeNest> => {
      counter += 1
      const response = await dispatch({ id: `r${counter}`, method: 'worktree.nest', params }, { connectionId })
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error)
      return response.result as WorktreeNest
    }
    return { s, call }
  }
  const WINDOW = `${WINDOW_CONNECTION_PREFIX}1`
  const SOCKET = 'socket_1'

  it("stops agents past three deep counting the moved worktree's children, and lets the window", async () => {
    const { s, call } = await wire()
    let deepest = await ready(s.service, { projectId: s.project.id, name: 'top' })
    for (const name of ['one', 'two']) {
      deepest = await ready(s.service, { projectId: s.project.id, name, parentId: deepest.id })
    }
    const moved = await ready(s.service, { projectId: s.project.id, name: 'moved', startedFrom: deepest.branch })
    await ready(s.service, { projectId: s.project.id, name: 'below', parentId: moved.id })

    const params = { worktreeId: moved.id, parentId: deepest.id }
    await expect(call(SOCKET, params)).rejects.toMatchObject({
      code: ErrorCode.ChildLimit,
      message: '3 deep under top',
      data: { refusal: 'depth' }
    })
    await expect(call(WINDOW, { ...params, fromTerminalId: 'term_1' })).rejects.toMatchObject({
      code: ErrorCode.ChildLimit
    })
    expect((await call(WINDOW, params)).worktree.parentId).toBe(deepest.id)
  })

  it('stops agents at six children under one parent', async () => {
    const { s, call } = await wire()
    const parent = await ready(s.service, { projectId: s.project.id, name: 'Rework auth session' })
    for (let index = 1; index <= MAX_OPEN_CHILDREN; index += 1) {
      await ready(s.service, { projectId: s.project.id, name: `part ${index}`, parentId: parent.id })
    }
    const seventh = await ready(s.service, { projectId: s.project.id, name: 'part 7', startedFrom: parent.branch })

    await expect(call(SOCKET, { worktreeId: seventh.id, parentId: parent.id })).rejects.toMatchObject({
      code: ErrorCode.ChildLimit,
      message: '6 open children under Rework auth session'
    })
    expect((await call(WINDOW, { worktreeId: seventh.id, parentId: parent.id })).change).toBe('nest')
  })
})
