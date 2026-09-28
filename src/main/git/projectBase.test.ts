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

/** A second clone of origin that commits `file` with `text` and pushes main, as a teammate on another machine would. */
async function teammate({ repo }: Setup): Promise<(file: string, text: string) => Promise<string>> {
  const clone = path.join(repo.base, 'teammate')
  await repo.git(['clone', '--quiet', path.join(repo.base, 'origin.git'), clone], repo.base)
  await repo.git(['config', 'user.name', 'Teammate'], clone)
  await repo.git(['config', 'user.email', 'mate@teamree.invalid'], clone)
  return async (file, text) => {
    await repo.git(['pull', '--quiet', '--no-rebase', 'origin', 'main'], clone)
    await repo.write(file, text, clone)
    await repo.commit(`Teammate: ${file}`, clone)
    await repo.git(['push', '--quiet', 'origin', 'main'], clone)
    return repo.git(['rev-parse', 'HEAD'], clone)
  }
}

async function taskWriting(context: Setup, name: string, file: string, text: string): Promise<Worktree> {
  const worktree = await context.service.whenSettled(
    (await context.service.createWorktree({ projectId: context.projectId, name })).id
  )
  if (worktree.state !== 'ready') throw new Error(worktree.error)
  await context.repo.write(file, text, worktree.path)
  await context.repo.commit(name, worktree.path)
  return worktree
}

const subjects = async (repo: TempRepo, ref = 'main'): Promise<string[]> =>
  (await repo.git(['log', '--format=%s', ref])).split('\n')

describe('landing onto a main origin moved', () => {
  it('behind: fetches first, lands on origin’s tip and pushes', async () => {
    const context = await setup()
    const push = await teammate(context)
    const worktree = await taskWriting(context, 'Fix cart', 'cart.ts', 'ours\n')
    await push('footer.ts', 'theirs\n')

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true })

    expect(merged).toMatchObject({ merged: true, pushed: true })
    expect(await originMain(context.repo)).toBe(await context.repo.git(['rev-parse', 'main']))
    expect(await subjects(context.repo)).toEqual(expect.arrayContaining(['Fix cart', 'Teammate: footer.ts']))
    expect(await context.service.projectBase({ projectId: context.projectId })).toMatchObject({ ahead: 0, behind: 0 })
  })

  it('ahead: pushes an earlier landing that was not pushed along with this one', async () => {
    const context = await setup()
    const first = await taskWriting(context, 'First', 'one.ts', 'one\n')
    const second = await taskWriting(context, 'Second', 'two.ts', 'two\n')
    await context.service.worktreeMergeIntoBase({ worktreeId: first.id })

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: second.id, push: true })

    expect(merged).toMatchObject({ merged: true, pushed: true })
    expect(await originMain(context.repo)).toBe(await context.repo.git(['rev-parse', 'main']))
    expect(await subjects(context.repo)).toEqual(expect.arrayContaining(['First', 'Second']))
  })

  it('diverged: takes origin in, then the task, and pushes', async () => {
    const context = await setup()
    const push = await teammate(context)
    const first = await taskWriting(context, 'First', 'one.ts', 'one\n')
    const second = await taskWriting(context, 'Second', 'two.ts', 'two\n')
    await context.service.worktreeMergeIntoBase({ worktreeId: first.id })
    await push('footer.ts', 'theirs\n')

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: second.id, push: true })

    expect(merged).toMatchObject({ merged: true, pushed: true })
    expect(await originMain(context.repo)).toBe(await context.repo.git(['rev-parse', 'main']))
    expect(await subjects(context.repo)).toEqual(expect.arrayContaining(['First', 'Second', 'Teammate: footer.ts']))
    expect(await context.service.projectBase({ projectId: context.projectId })).toMatchObject({ ahead: 0, behind: 0 })
  })

  it('conflicting: stops before merging the task, never diverges main, and lands once the task takes the conflict', async () => {
    const context = await setup()
    const push = await teammate(context)
    const worktree = await taskWriting(context, 'Fix cart', 'CHANGELOG.md', 'cart rounding\n')
    const theirs = await push('CHANGELOG.md', 'footer copy\n')

    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true }))

    expect(error.message).toBe(`${worktree.branch} conflicts with main in CHANGELOG.md`)
    expect(error.data).toMatchObject({ conflicts: ['CHANGELOG.md'] })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(theirs)
    expect(await originMain(context.repo)).toBe(theirs)
    expect(await context.service.projectBase({ projectId: context.projectId })).toMatchObject({ ahead: 0, behind: 0 })
    expect((await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, dryRun: true })).conflicts).toEqual([
      'CHANGELOG.md'
    ])

    const update = await context.service.worktreeUpdate({ worktreeId: worktree.id, landing: true })
    expect(update).toMatchObject({ outcome: 'conflicts', conflicts: ['CHANGELOG.md'] })
    await context.repo.write('CHANGELOG.md', 'footer copy\ncart rounding\n', worktree.path)
    await context.service.worktreeResolve({ worktreeId: worktree.id, path: 'CHANGELOG.md' })
    await context.service.worktreeContinueUpdate({ worktreeId: worktree.id })

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true })
    expect(merged).toMatchObject({ merged: true, pushed: true })
    expect(await context.repo.git(['show', 'origin/main:CHANGELOG.md'])).toBe('footer copy\ncart rounding')
  })

  it('reads a plan’s conflicts, and updates the task, against origin’s tip when main is behind it', async () => {
    const context = await setup()
    const push = await teammate(context)
    const worktree = await taskWriting(context, 'Fix cart', 'CHANGELOG.md', 'cart rounding\n')
    await push('CHANGELOG.md', 'footer copy\n')
    await context.repo.git(['fetch', '--quiet', 'origin'])
    const before = await context.repo.git(['rev-parse', 'main'])

    const plan = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, dryRun: true })
    expect(plan.conflicts).toEqual(['CHANGELOG.md'])

    const update = await context.service.worktreeUpdate({ worktreeId: worktree.id, landing: true })
    expect(update).toMatchObject({ outcome: 'conflicts', conflicts: ['CHANGELOG.md'] })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
  })

  it('puts main back when the push fails after the merge, and says so', async () => {
    const context = await setup()
    const worktree = await taskWriting(context, 'Fix cart', 'cart.ts', 'ours\n')
    const before = await context.repo.git(['rev-parse', 'main'])
    await context.repo.git(['remote', 'set-url', '--push', 'origin', path.join(context.repo.base, 'missing.git')])

    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, push: true }))

    expect(error.message).toBe('Push failed: origin not found · merge undone')
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).merged).toBe(false)
  })

  it('refuses before anything moves when main already conflicts with origin', async () => {
    const context = await setup()
    const push = await teammate(context)
    const first = await taskWriting(context, 'First', 'CHANGELOG.md', 'ours\n')
    const second = await taskWriting(context, 'Second', 'two.ts', 'two\n')
    await context.service.worktreeMergeIntoBase({ worktreeId: first.id })
    await push('CHANGELOG.md', 'theirs\n')
    const before = await context.repo.git(['rev-parse', 'main'])

    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: second.id, push: true }))

    expect(error.message).toBe('main conflicts with origin/main in CHANGELOG.md')
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
    expect(await context.repo.git(['status', '--porcelain'])).toBe('')
  })

  it('undoes a merge that cannot be pulled, leaving the task its commits', async () => {
    const context = await setup()
    const push = await teammate(context)
    const worktree = await taskWriting(context, 'Fix cart', 'CHANGELOG.md', 'cart rounding\n')
    await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id })
    const theirs = await push('CHANGELOG.md', 'footer copy\n')

    expect((await rejection(context.service.projectPushBase({ projectId: context.projectId }))).message).toBe(
      'origin/main moved'
    )
    const pulled = await rejection(context.service.projectPullBase({ projectId: context.projectId }))
    expect(pulled.data).toMatchObject({ conflicts: ['CHANGELOG.md'] })

    const base = await context.service.projectResetBase({ projectId: context.projectId })

    expect(base).toMatchObject({ ahead: 0, behind: 0 })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(theirs)
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).merged).toBe(false)
    expect(await subjects(context.repo, worktree.branch)).toContain('Fix cart')
  })

  it('refuses to undo when main holds a commit no branch does', async () => {
    const context = await setup()
    const push = await teammate(context)
    await context.repo.write('CHANGELOG.md', 'mine\n')
    await context.repo.commit('Straight on main')
    await push('CHANGELOG.md', 'theirs\n')
    const before = await context.repo.git(['rev-parse', 'main'])

    const error = await rejection(context.service.projectResetBase({ projectId: context.projectId }))

    expect(error.message).toBe('1 commit is only on main')
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
  })
})
