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

/** A script named gh that answers the calls the landing and a failing check make, and logs every call. */
async function standInGh(repo: TempRepo, signedIn: boolean): Promise<string> {
  const file = path.join(repo.base, 'gh')
  const state = path.join(repo.base, 'pr.json')
  const log = path.join(repo.base, 'gh.log')
  const runLog = path.join(repo.base, 'run.log')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "auth status") exit ${signedIn ? 0 : 1} ;;`,
      `  "pr view") if [ -f '${state}' ]; then cat '${state}'; exit 0; fi; echo 'no pull requests found' >&2; exit 1 ;;`,
      `  "run view") if [ -f '${runLog}' ]; then cat '${runLog}'; exit 0; fi; exit 1 ;;`,
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

const FAILING_PR = JSON.stringify({
  number: 42,
  url: 'https://github.com/acme/pantry/pull/42',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'test',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/acme/pantry/actions/runs/7/job/70'
    },
    {
      __typename: 'CheckRun',
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/acme/pantry/actions/runs/7/job/71'
    }
  ]
})

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

  it('says whether there is a remote to publish to', async () => {
    const { service, projectId } = await setup()
    const worktree = await service.whenSettled((await service.createWorktree({ projectId, name: 'Hub' })).id)
    expect((await service.worktreeLanding({ worktreeId: worktree.id })).remote).toBe(true)

    const repo = await createTempRepo()
    repos.push(repo)
    const local = await service.addProject({ path: repo.repoPath })
    const alone = await service.whenSettled((await service.createWorktree({ projectId: local.id, name: 'Alone' })).id)
    expect(await service.worktreeLanding({ worktreeId: alone.id })).toMatchObject({ host: null, remote: false })
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

  it('closes the issue a worktree was started from, keeping the commit as title and body', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const issue = { number: 123, url: 'https://github.com/acme/pantry/issues/123' }
    const pending = await context.service.createWorktree({ projectId: context.projectId, name: 'Login loop', issue })
    const worktree = await context.service.whenSettled(pending.id)
    expect(worktree.issue).toEqual(issue)
    await context.repo.write('src/login.ts', 'export const loop = false\n', worktree.path)
    await context.repo.git(['add', '--all'], worktree.path)
    await context.repo.git(
      ['commit', '-m', 'Stop the login loop', '-m', 'The redirect kept its own URL.'],
      worktree.path
    )
    await context.service.worktreePush({ worktreeId: worktree.id })

    await context.service.worktreeCreatePullRequest({ worktreeId: worktree.id })

    const log = await readFile(path.join(context.repo.base, 'gh.log'), 'utf8')
    expect(log).toContain(
      `pr create --title Stop the login loop --body The redirect kept its own URL.\n\nCloses #123 --head ${worktree.branch} --base main`
    )
  })

  it('does not close the issue twice when the commit already does', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const issue = { number: 123, url: 'https://github.com/acme/pantry/issues/123' }
    const pending = await context.service.createWorktree({ projectId: context.projectId, name: 'Login loop', issue })
    const worktree = await context.service.whenSettled(pending.id)
    await context.repo.write('src/login.ts', 'export const loop = false\n', worktree.path)
    await context.repo.git(['add', '--all'], worktree.path)
    await context.repo.git(['commit', '-m', 'Stop the login loop', '-m', 'Closes #123'], worktree.path)
    await context.service.worktreePush({ worktreeId: worktree.id })

    await context.service.worktreeCreatePullRequest({ worktreeId: worktree.id })

    const log = await readFile(path.join(context.repo.base, 'gh.log'), 'utf8')
    expect(log).toContain(`pr create --title Stop the login loop --body Closes #123 --head ${worktree.branch}`)
  })

  it('lists the commits and closes the issue when there are several', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const issue = { number: 9, url: 'https://github.com/acme/pantry/issues/9' }
    const pending = await context.service.createWorktree({ projectId: context.projectId, name: 'Two steps', issue })
    const worktree = await context.service.whenSettled(pending.id)
    await context.repo.write('a.txt', 'a\n', worktree.path)
    await context.repo.commit('First step', worktree.path)
    await context.repo.write('b.txt', 'b\n', worktree.path)
    await context.repo.commit('Second step', worktree.path)
    await context.service.worktreePush({ worktreeId: worktree.id })

    await context.service.worktreeCreatePullRequest({ worktreeId: worktree.id })

    const log = await readFile(path.join(context.repo.base, 'gh.log'), 'utf8')
    expect(log).toContain(`pr create --title Two steps --body - First step\n- Second step\n\nCloses #9 --head`)
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

  it('reads checks and review with the pull request, and asks gh again when told to or after a push', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })
    await writeFile(path.join(context.repo.base, 'pr.json'), FAILING_PR)
    const views = async (): Promise<number> =>
      (await ghCalls(context.repo)).filter((call) => call.startsWith('pr view')).length

    const landing = await context.service.worktreeLanding({ worktreeId: worktree.id })
    expect(landing.pullRequest).toMatchObject({
      number: 42,
      review: 'changes',
      checks: { passing: 1, failing: 1, pending: 0 }
    })
    expect((await ghCalls(context.repo)).find((call) => call.startsWith('pr view'))).toBe(
      `pr view ${worktree.branch} --json number,url,state,isDraft,reviewDecision,statusCheckRollup`
    )

    await context.service.worktreeLanding({ worktreeId: worktree.id })
    expect(await views()).toBe(1)
    await context.service.worktreeLanding({ worktreeId: worktree.id, fresh: true })
    expect(await views()).toBe(2)
    await context.repo.write('src/more.ts', 'export const more = 1\n', worktree.path)
    await context.repo.commit('More', worktree.path)
    await context.service.worktreePush({ worktreeId: worktree.id })
    await context.service.worktreeLanding({ worktreeId: worktree.id })
    expect(await views()).toBe(3)
  })

  it('reads a failing check’s log for its job, trimmed to the failure', async () => {
    const context = await setup({ gh: 'signed-in' })
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })
    await writeFile(path.join(context.repo.base, 'pr.json'), FAILING_PR)
    await writeFile(
      path.join(context.repo.base, 'run.log'),
      'test\tRun npm test\t2026-09-26T18:00:00.0000000Z FAIL src/sum.test.ts\n'
    )

    const failure = await context.service.worktreeCheckFailure({ worktreeId: worktree.id, name: 'test' })

    expect(failure).toEqual({
      worktreeId: worktree.id,
      name: 'test',
      url: 'https://github.com/acme/pantry/actions/runs/7/job/70',
      excerpt: 'FAIL src/sum.test.ts'
    })
    expect(await ghCalls(context.repo)).toContain('run view --job 70 --log-failed')
    expect(
      (await rejection(context.service.worktreeCheckFailure({ worktreeId: worktree.id, name: 'lint' }))).code
    ).toBe(ErrorCode.Conflict)
  })

  it('refuses a failing check’s log without gh', async () => {
    const context = await setup()
    await lookLikeGitHub(context.repo)
    const worktree = await worktreeWithCommit(context)
    await context.service.worktreePush({ worktreeId: worktree.id })

    expect(
      (await rejection(context.service.worktreeCheckFailure({ worktreeId: worktree.id, name: 'test' }))).code
    ).toBe(ErrorCode.Conflict)
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
