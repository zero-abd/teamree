import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { remoteForge } from './reviewUrl'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Setup = { repo: TempRepo; service: GitService; projectId: string }

async function setup(options: { gh?: 'signed-in' | 'signed-out' } = {}): Promise<Setup> {
  const repo = await createTempRepo({ withRemote: true })
  repos.push(repo)
  const gh = options.gh === undefined ? null : await standInGh(repo, options.gh === 'signed-in')
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ghBinary: () => gh })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, projectId: project.id }
}

/** A script named gh that answers the three calls the landing makes, and logs every call. */
async function standInGh(repo: TempRepo, signedIn: boolean): Promise<string> {
  const file = path.join(repo.base, 'gh')
  const state = path.join(repo.base, 'pr.json')
  const log = path.join(repo.base, 'gh.log')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "auth status") exit ${signedIn ? 0 : 1} ;;`,
      `  "pr view") if [ -f '${state}' ]; then cat '${state}'; exit 0; fi; echo 'no pull requests found' >&2; exit 1 ;;`,
      `  "pr create") echo '{"number":12,"url":"https://github.com/acme/pantry/pull/12","state":"OPEN"}' > '${state}'; echo 'https://github.com/acme/pantry/pull/12'; exit 0 ;;`,
      'esac',
      'exit 2',
      ''
    ].join('\n'),
    'utf8'
  )
  await chmod(file, 0o755)
  return file
}

async function ghCalls(repo: TempRepo): Promise<string[]> {
  return (await readFile(path.join(repo.base, 'gh.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
}

/** Reads as GitHub while every push still lands in the local bare repository. */
async function lookLikeGitHub(repo: TempRepo): Promise<void> {
  const bare = await repo.git(['remote', 'get-url', 'origin'])
  await repo.git(['remote', 'set-url', '--push', 'origin', bare])
  await repo.git(['remote', 'set-url', 'origin', 'git@github.com:acme/pantry.git'])
}

async function worktreeWithCommit({ repo, service, projectId }: Setup, name = 'Add sub'): Promise<Worktree> {
  const pending = await service.createWorktree({ projectId, name })
  const worktree = await service.whenSettled(pending.id)
  if (worktree.state !== 'ready') throw new Error(worktree.error)
  await repo.write('src/math.ts', `export const ${name.replace(/\W/g, '')} = 1\n`, worktree.path)
  await repo.commit(name, worktree.path)
  return worktree
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

describe('remoteForge', () => {
  it('names GitHub from its ssh, scp-like and https remotes', () => {
    expect(remoteForge('git@github.com:acme/pantry.git')).toBe('github')
    expect(remoteForge('ssh://git@github.com/acme/pantry.git')).toBe('github')
    expect(remoteForge('https://github.com/acme/pantry.git')).toBe('github')
    expect(remoteForge('https://gitlab.com/acme/pantry')).toBe('gitlab')
  })

  it('names nothing for a path or a host it does not know', () => {
    expect(remoteForge('/tmp/origin.git')).toBeNull()
    expect(remoteForge('https://git.example.com/acme/pantry.git')).toBeNull()
    expect(remoteForge('')).toBeNull()
  })
})

describe('worktree landing', () => {
  it('is not merged before the branch has made a commit, though git would call it so', async () => {
    const { service, projectId } = await setup()
    const pending = await service.createWorktree({ projectId, name: 'Fresh' })
    const worktree = await service.whenSettled(pending.id)

    const landing = await service.worktreeLanding({ worktreeId: worktree.id })

    expect(landing).toMatchObject({ host: null, published: false, merged: false, unmerged: 0, base: 'main' })
  })

  it('counts the commits the base lacks, and sees the branch once it is published', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)

    expect(await context.service.worktreeLanding({ worktreeId: worktree.id })).toMatchObject({
      unmerged: 1,
      merged: false,
      published: false
    })
    await context.service.worktreePush({ worktreeId: worktree.id })
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).published).toBe(true)
  })

  it('fast-forwards main in the project checkout, and the branch then reads as merged', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)

    const plan = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, dryRun: true })
    expect(plan).toMatchObject({ into: 'main', fastForward: true, dirty: [], merged: false })
    expect(plan.commits.map((commit) => commit.subject)).toEqual(['Add sub'])
    // A plan changes nothing.
    expect(await context.repo.git(['rev-list', '--count', 'main..' + worktree.branch])).toBe('1')

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id })

    expect(merged).toMatchObject({ merged: true, fastForward: true })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(await context.repo.git(['rev-parse', worktree.branch]))
    expect(await context.service.worktreeLanding({ worktreeId: worktree.id })).toMatchObject({
      merged: true,
      unmerged: 0
    })
  })

  it('makes a merge commit when main has moved on', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await context.repo.write('CHANGELOG.md', 'moved\n')
    await context.repo.commit('Main moved')

    const merged = await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id })

    expect(merged.fastForward).toBe(false)
    expect(await context.repo.git(['rev-list', '--count', '--merges', 'main^..main'])).toBe('1')
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).merged).toBe(true)
  })

  it('refuses with the file list when the project checkout has uncommitted work', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await context.repo.write('README.md', 'edited on main\n')
    const before = await context.repo.git(['rev-parse', 'main'])

    expect((await context.service.worktreeMergeIntoBase({ worktreeId: worktree.id, dryRun: true })).dirty).toEqual([
      'README.md'
    ])
    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: worktree.id }))

    expect(error.code).toBe(ErrorCode.Conflict)
    expect(error.data).toEqual({ dirty: ['README.md'] })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
    expect(await readFile(path.join(context.repo.repoPath, 'README.md'), 'utf8')).toBe('edited on main\n')
  })

  it('refuses when the project checkout is on another branch', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await context.repo.git(['checkout', '-b', 'elsewhere'])

    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: worktree.id }))

    expect(error.code).toBe(ErrorCode.Conflict)
    expect(error.message).toContain('elsewhere')
  })

  it('backs out of a merge that conflicts and leaves main as it was', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await context.repo.write('src/math.ts', 'export const other = 2\n')
    await context.repo.commit('Main wrote the same file')
    const before = await context.repo.git(['rev-parse', 'main'])

    const error = await rejection(context.service.worktreeMergeIntoBase({ worktreeId: worktree.id }))

    expect(error.code).toBe(ErrorCode.Conflict)
    expect(error.data).toEqual({ conflicts: ['src/math.ts'] })
    expect(await context.repo.git(['rev-parse', 'main'])).toBe(before)
    expect(await context.repo.git(['status', '--porcelain'])).toBe('')
  })
})

describe('pull requests', () => {
  it('opens one with gh when gh is signed in, then reads it back as open', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })

    const before = await context.service.worktreeLanding({ worktreeId: worktree.id })
    expect(before).toMatchObject({ host: 'github', published: true, merged: false })
    expect(before.pullRequest).toBeUndefined()

    const made = await context.service.worktreeCreatePullRequest({ worktreeId: worktree.id })

    expect(made).toEqual({
      worktreeId: worktree.id,
      url: 'https://github.com/acme/pantry/pull/12',
      number: 12,
      created: true
    })
    expect(await ghCalls(context.repo)).toContain(`pr create --fill --head ${worktree.branch} --base main`)
    expect((await context.service.worktreeLanding({ worktreeId: worktree.id })).pullRequest).toEqual({
      number: 12,
      url: 'https://github.com/acme/pantry/pull/12',
      state: 'open'
    })
  })

  it('hands back the compare page when gh is not signed in, and never runs pr create', async () => {
    const context = await setup({ gh: 'signed-out' })
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })

    const made = await context.service.worktreeCreatePullRequest({ worktreeId: worktree.id })

    expect(made).toEqual({
      worktreeId: worktree.id,
      url: `https://github.com/acme/pantry/compare/main...${worktree.branch}?expand=1`,
      created: false
    })
    expect((await ghCalls(context.repo)).some((call) => call.startsWith('pr create'))).toBe(false)
  })

  it('reads a merged pull request as merged, whatever the commits say', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })
    await writeFile(
      path.join(context.repo.base, 'pr.json'),
      '{"number":7,"url":"https://github.com/acme/pantry/pull/7","state":"MERGED"}'
    )

    const landing = await context.service.worktreeLanding({ worktreeId: worktree.id })

    expect(landing).toMatchObject({ merged: true, pullRequest: { number: 7, state: 'merged' } })
  })

  it('is refused for an origin that is not a known host', async () => {
    const context = await setup()
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })

    expect((await rejection(context.service.worktreeCreatePullRequest({ worktreeId: worktree.id }))).code).toBe(
      ErrorCode.Conflict
    )
  })
})
