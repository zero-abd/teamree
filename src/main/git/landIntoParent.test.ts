// A child lands in its parent's checkout and updates from its parent's branch, against real git.

import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Tree = { repo: TempRepo; service: GitService; parent: Worktree; child: Worktree; working: Set<string> }

/** A parent with one commit and a child cut from it, on a GitHub-looking origin. */
async function tree(): Promise<Tree> {
  const repo = await createTempRepo({ withRemote: true })
  repos.push(repo)
  const working = new Set<string>()
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, agentWorking: (id) => working.has(id) })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
  await repo.write('auth.ts', 'parent\n', parent.path)
  await repo.commit('parent work', parent.path)
  const child = await ready(service, { projectId: project.id, name: 'Write tests', parentId: parent.id })
  const bare = await repo.git(['remote', 'get-url', 'origin'])
  await repo.git(['remote', 'set-url', '--push', 'origin', bare])
  await repo.git(['remote', 'set-url', 'origin', 'git@github.com:acme/pantry.git'])
  return { repo, service, parent, child, working }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree(params)).id)
  if (settled.state !== 'ready') throw new Error(settled.error)
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

describe('landing a child', () => {
  it('merges into the parent checkout, never main, and never offers a pull request', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    await repo.git(['push', '-u', 'origin', child.branch], child.path)

    const before = await service.worktreeLanding({ worktreeId: child.id })
    expect(before).toMatchObject({
      base: parent.branch,
      host: null,
      unmerged: 1,
      merged: false,
      parent: { worktreeId: parent.id, name: 'Rework auth' }
    })
    expect(before.compareUrl).toBeUndefined()
    await expect(service.worktreeCreatePullRequest({ worktreeId: child.id })).rejects.toThrow()

    const plan = await service.worktreeMergeIntoBase({ worktreeId: child.id, dryRun: true })
    expect(plan).toMatchObject({ into: parent.branch, checkout: parent.path, fastForward: true, dirty: [] })
    const merged = await service.worktreeMergeIntoBase({ worktreeId: child.id })
    expect(merged.merged).toBe(true)

    expect(await repo.git(['log', '--format=%s', '-1'], parent.path)).toBe('child tests')
    expect(await repo.git(['log', '--format=%s', 'main'])).not.toContain('child tests')
    expect(await repo.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main')
  })

  it('is landed once its commits are in the parent, whatever main has', async () => {
    const { repo, service, child } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    await service.worktreeMergeIntoBase({ worktreeId: child.id })

    expect(await service.worktreeLanding({ worktreeId: child.id })).toMatchObject({ merged: true, unmerged: 0 })
  })

  it('makes a merge commit when the parent moved on', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    await repo.write('session.ts', 'more\n', parent.path)
    await repo.commit('parent moved', parent.path)

    const merged = await service.worktreeMergeIntoBase({ worktreeId: child.id })
    expect(merged).toMatchObject({ fastForward: false, merged: true })
    expect(await repo.git(['log', '--format=%P', '-1'], parent.path)).toContain(' ')
  })

  it('refuses over uncommitted parent changes to the files it brings, and names them', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.ts', 'child edit\n', child.path)
    await repo.commit('child edit', child.path)
    await repo.write('auth.ts', 'parent draft\n', parent.path)

    const plan = await service.worktreeMergeIntoBase({ worktreeId: child.id, dryRun: true })
    expect(plan.dirty).toEqual(['auth.ts'])
    const refused = await rejection(service.worktreeMergeIntoBase({ worktreeId: child.id }))
    expect(refused.code).toBe(ErrorCode.Conflict)
    expect(refused.message).toBe('Rework auth has uncommitted changes to auth.ts')
    expect(refused.data).toEqual({ dirty: ['auth.ts'] })
    expect(await repo.git(['log', '--format=%s', '-1'], parent.path)).toBe('parent work')
  })

  it('lands past uncommitted parent changes it does not touch, and leaves them', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    await repo.write('auth.ts', 'parent draft\n', parent.path)

    expect((await service.worktreeMergeIntoBase({ worktreeId: child.id, dryRun: true })).dirty).toEqual([])
    expect((await service.worktreeMergeIntoBase({ worktreeId: child.id })).merged).toBe(true)
    expect(await repo.git(['status', '--porcelain'], parent.path)).toBe('M auth.ts')
  })

  it("refuses while the parent's agent is mid-turn", async () => {
    const { repo, service, parent, child, working } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    working.add(parent.id)

    const refused = await rejection(service.worktreeMergeIntoBase({ worktreeId: child.id }))
    expect(refused.message).toBe("Rework auth's agent is working")
    expect(await repo.git(['log', '--format=%s', '-1'], parent.path)).toBe('parent work')
    working.clear()
    expect((await service.worktreeMergeIntoBase({ worktreeId: child.id })).merged).toBe(true)
  })
})

describe('updating a child from its parent', () => {
  it('counts what the parent committed since the fork as behind, and rebases onto it', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    await repo.write('session.ts', 'one\n', parent.path)
    await repo.commit('parent one', parent.path)
    await repo.write('token.ts', 'two\n', parent.path)
    await repo.commit('parent two', parent.path)

    expect(await service.worktreeStatus({ worktreeId: child.id })).toMatchObject({ behind: 2 })
    const updated = await service.worktreeUpdate({ worktreeId: child.id })
    expect(updated).toMatchObject({ baseRef: parent.branch, mode: 'rebase', outcome: 'updated' })
    expect(await service.worktreeStatus({ worktreeId: child.id })).toMatchObject({ behind: 0, ahead: 1 })
    expect(await repo.git(['log', '--format=%s', '-3'], child.path)).toBe('child tests\nparent two\nparent one')
  })

  it('merges when the child is published, and stops on a conflict for the abort', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('auth.ts', 'child\n', child.path)
    await repo.commit('child edit', child.path)
    await repo.git(['push', '-u', 'origin', child.branch], child.path)
    await repo.write('auth.ts', 'parent again\n', parent.path)
    await repo.commit('parent edit', parent.path)

    const stopped = await service.worktreeUpdate({ worktreeId: child.id })
    expect(stopped).toMatchObject({
      baseRef: parent.branch,
      mode: 'merge',
      outcome: 'conflicts',
      conflicts: ['auth.ts']
    })
    expect(await service.worktreeAbortUpdate({ worktreeId: child.id })).toMatchObject({ aborted: 'merge' })
    expect(await repo.git(['log', '--format=%s', '-1'], child.path)).toBe('child edit')
  })
})
