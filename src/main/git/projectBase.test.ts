import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Setup = { repo: TempRepo; service: GitService; projectId: string }

async function setup(withRemote = true): Promise<Setup> {
  const repo = await createTempRepo({ withRemote })
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, projectId: project.id }
}

async function worktreeWithCommit({ repo, service, projectId }: Setup, name = 'Add sub'): Promise<Worktree> {
  const worktree = await service.whenSettled((await service.createWorktree({ projectId, name })).id)
  if (worktree.state !== 'ready') throw new Error(worktree.error)
  await repo.write(`src/${name.replace(/\W/g, '')}.ts`, `export const one = 1\n`, worktree.path)
  await repo.commit(name, worktree.path)
  return worktree
}

/** Moves origin's main from a second clone, as a teammate would. */
async function teammatePushes({ repo }: Setup, file: string): Promise<void> {
  const origin = path.join(repo.base, 'origin.git')
  const clone = path.join(repo.base, 'teammate')
  await repo.git(['clone', '--quiet', origin, clone], repo.base)
  await repo.git(['config', 'user.name', 'Teammate'], clone)
  await repo.git(['config', 'user.email', 'mate@teamree.invalid'], clone)
  await repo.write(file, 'theirs\n', clone)
  await repo.commit('Teammate pushed', clone)
  await repo.git(['push', '--quiet', 'origin', 'main'], clone)
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

const originMain = (repo: TempRepo): Promise<string> =>
  repo.git(['rev-parse', 'main'], path.join(repo.base, 'origin.git'))

describe('landing reaches origin', () => {
  it('merges and pushes main to a bare origin in one step', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true })

    expect(merged).toMatchObject({ merged: true, pushed: true })
    expect(await originMain(context.repo)).toBe(await context.repo.git(['rev-parse', 'main']))
    expect(await context.service.projectBase({ projectId: context.projectId })).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0
    })
    const landing = await context.service.worktreeLanding({ worktreeId: worktree.id })
    expect(landing.merged).toBe(true)
    expect(landing.notPushed).toBeUndefined()
  })

  it('leaves origin alone without push, and says the landing is not pushed', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    const before = await originMain(context.repo)

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id })

    expect(merged.merged).toBe(true)
    expect(merged.pushed).toBeUndefined()
    expect(await originMain(context.repo)).toBe(before)
    expect(await context.service.worktreeLanding({ worktreeId: worktree.id })).toMatchObject({
      merged: true,
      notPushed: true
    })
    expect((await context.service.projectBase({ projectId: context.projectId })).ahead).toBe(1)

    await context.service.projectPushBase({ projectId: context.projectId })

    expect(await originMain(context.repo)).toBe(await context.repo.git(['rev-parse', 'main']))
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).notPushed).toBeUndefined()
  })

  it('counts main against its upstream both ways', async () => {
    const context = await setup()
    await context.repo.write('a.md', 'a\n')
    await context.repo.commit('One')
    await context.repo.write('b.md', 'b\n')
    await context.repo.commit('Two')
    await teammatePushes(context, 'c.md')
    await context.repo.git(['fetch', '--quiet', 'origin'])

    expect(await context.service.projectBase({ projectId: context.projectId })).toMatchObject({
      upstream: 'origin/main',
      ahead: 2,
      behind: 1
    })
  })

  it('merges but reports a rejected push in one line, and Pull then Push lands both', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await teammatePushes(context, 'theirs.md')

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true })

    expect(merged.merged).toBe(true)
    expect(merged.pushed).toBe(false)
    expect(merged.pushError).toMatchObject({ message: 'origin/main moved', kind: 'rejected' })
    expect(merged.pushError?.detail).toMatch(/rejected|fetch first|non-fast-forward/)

    await context.service.projectPullBase({ projectId: context.projectId })
    await context.service.projectPushBase({ projectId: context.projectId })

    const tip = await context.repo.git(['rev-parse', 'main'])
    expect(await originMain(context.repo)).toBe(tip)
    expect(await context.repo.git(['log', '--format=%s', 'main'])).toContain('Teammate pushed')
    expect(await context.repo.git(['log', '--format=%s', 'main'])).toContain('Add sub')
  })

  it('refuses a push with no remote in one line', async () => {
    const context = await setup(false)

    const base = await context.service.projectBase({ projectId: context.projectId })
    expect(base).toMatchObject({ branch: 'main', ahead: 0, behind: 0 })
    expect(base.upstream).toBeUndefined()

    const error = await rejection(context.service.projectPushBase({ projectId: context.projectId }))
    expect(error.message).toBe('no remote')
  })

  it('refuses a push origin denies with its own reason', async () => {
    const context = await setup()
    await context.repo.write('a.md', 'a\n')
    await context.repo.commit('One')
    await context.repo.git(['remote', 'set-url', '--push', 'origin', path.join(context.repo.base, 'missing.git')])

    const error = await rejection(context.service.projectPushBase({ projectId: context.projectId }))
    expect(error.message).toBe('origin not found')
    expect((error.data as { detail?: string }).detail).toMatch(/missing\.git/)
  })
})
