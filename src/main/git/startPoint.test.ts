import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService, type GitServiceOptions } from './gitService'
import { resolveStartPoint } from './startPoint'
import { createTempRepo, type TempRepo, type TempRepoOptions } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(options?: TempRepoOptions): Promise<TempRepo> {
  const repo = await createTempRepo(options)
  repos.push(repo)
  return repo
}

function newService(repo: TempRepo, options: GitServiceOptions = {}): GitService {
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...options })
  services.push(service)
  return service
}

function resolve(repo: TempRepo, requested: string): ReturnType<typeof resolveStartPoint> {
  return resolveStartPoint(repo.runner, { root: repo.repoPath, requested })
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

/** A second clone pushing to the shared bare origin, so `repo` has never seen it. */
async function pushFromElsewhere(repo: TempRepo, branch: string): Promise<string> {
  const clone = path.join(repo.base, `contributor-${branch.replace(/\//g, '-')}`)
  await repo.git(['clone', path.join(repo.base, 'origin.git'), clone], repo.base)
  await repo.git(['config', 'user.name', 'Contributor'], clone)
  await repo.git(['config', 'user.email', 'contributor@teamree.invalid'], clone)
  await repo.git(['checkout', '-b', branch], clone)
  await repo.write('contributed.txt', `${branch}\n`, clone)
  await repo.commit(`work on ${branch}`, clone)
  await repo.git(['push', 'origin', branch], clone)
  return repo.git(['rev-parse', 'HEAD'], clone)
}

describe('resolveStartPoint', () => {
  it('resolves a local branch, a tag, HEAD, and a full or abbreviated sha', async () => {
    const repo = await newRepo()
    const first = await repo.git(['rev-parse', 'HEAD'])
    await repo.write('second.txt', 'second\n')
    await repo.commit('second commit')
    const head = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['branch', 'feature/login', first])
    await repo.git(['tag', '-a', 'v1.0.0', '-m', 'release one', first])

    const branch = await resolve(repo, 'feature/login')
    expect(branch).toMatchObject({ kind: 'localBranch', sha: first, refName: 'refs/heads/feature/login' })
    expect(branch.track).toBeUndefined()
    expect(branch.interpretation).toContain('local branch feature/login')

    // An annotated tag is peeled: the start point has to be a commit.
    const tag = await resolve(repo, 'v1.0.0')
    expect(tag).toMatchObject({ kind: 'tag', sha: first, refName: 'refs/tags/v1.0.0' })

    const fromHead = await resolve(repo, 'HEAD')
    expect(fromHead).toMatchObject({ kind: 'head', sha: head })
    expect(fromHead.interpretation).toContain('on main')

    expect(await resolve(repo, first)).toMatchObject({ kind: 'commit', sha: first })
    const abbreviated = await resolve(repo, first.slice(0, 8))
    expect(abbreviated).toMatchObject({ kind: 'commit', sha: first })
    expect(abbreviated.interpretation).toContain('abbreviation')
    expect(abbreviated.shortSha.length).toBeGreaterThanOrEqual(7)
  })

  it('resolves a remote-tracking branch and reports the ref to track', async () => {
    const repo = await newRepo({ withRemote: true })

    const resolved = await resolve(repo, 'origin/main')

    expect(resolved.kind).toBe('remoteBranch')
    expect(resolved.refName).toBe('refs/remotes/origin/main')
    expect(resolved.track).toBe('origin/main')
    expect(resolved.fetched).toBe(false)
    expect(resolved.sha).toBe(await repo.git(['rev-parse', 'main']))
  })

  it('takes a full ref path literally', async () => {
    const repo = await newRepo()
    const head = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['tag', 'shipped'])

    const resolved = await resolve(repo, 'refs/tags/shipped')

    expect(resolved).toMatchObject({ kind: 'tag', sha: head, refName: 'refs/tags/shipped' })
    expect(resolved.interpretation).toBe('the ref refs/tags/shipped')
  })

  it('prefers the local branch over a tag of the same name and names what it passed over', async () => {
    const repo = await newRepo()
    const first = await repo.git(['rev-parse', 'HEAD'])
    await repo.write('second.txt', 'second\n')
    await repo.commit('second commit')
    const second = await repo.git(['rev-parse', 'HEAD'])
    // Same name, two different commits: the one case where guessing is fatal.
    await repo.git(['branch', 'release', second])
    await repo.git(['tag', 'release', first])

    const resolved = await resolve(repo, 'release')

    expect(resolved.kind).toBe('localBranch')
    expect(resolved.sha).toBe(second)
    expect(resolved.alternatives).toEqual([{ kind: 'tag', refName: 'refs/tags/release', sha: first }])
    expect(resolved.interpretation).toBe('used the local branch release; ignored refs/tags/release')
  })

  it('refuses a bare name that two remotes disagree about, and accepts one they agree on', async () => {
    const repo = await newRepo({ withRemote: true })
    const first = await repo.git(['rev-parse', 'HEAD'])
    await repo.write('second.txt', 'second\n')
    await repo.commit('second commit')
    const second = await repo.git(['rev-parse', 'HEAD'])

    const upstreamPath = path.join(repo.base, 'upstream.git')
    await repo.git(['init', '--bare', upstreamPath], repo.base)
    await repo.git(['remote', 'add', 'upstream', upstreamPath])
    await repo.git(['push', 'origin', `${first}:refs/heads/shared`])
    await repo.git(['push', 'upstream', `${second}:refs/heads/shared`])
    await repo.git(['push', 'upstream', `${second}:refs/heads/agreed`])
    await repo.git(['push', 'origin', `${second}:refs/heads/agreed`])
    await repo.git(['fetch', 'origin'])
    await repo.git(['fetch', 'upstream'])

    const error = await rejection(resolve(repo, 'shared'))
    expect(error.code).toBe(ErrorCode.Conflict)
    expect(error.message).toContain('origin/shared, upstream/shared')

    // Qualifying the remote is always available as the way out.
    expect((await resolve(repo, 'origin/shared')).sha).toBe(first)
    expect((await resolve(repo, 'upstream/shared')).sha).toBe(second)

    // Two remotes at the same commit are not a disagreement.
    const agreed = await resolve(repo, 'agreed')
    expect(agreed.kind).toBe('remoteBranch')
    expect(agreed.sha).toBe(second)
  })

  it('fetches a remote branch the local repository has never seen', async () => {
    const repo = await newRepo({ withRemote: true })
    const remoteSha = await pushFromElsewhere(repo, 'spike/parser')

    expect(await repo.git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/spike/parser'])).toBe('')

    const resolved = await resolve(repo, 'origin/spike/parser')

    expect(resolved).toMatchObject({
      kind: 'remoteBranch',
      sha: remoteSha,
      track: 'origin/spike/parser',
      fetched: true
    })
    expect(resolved.interpretation).toContain('fetched and used')
    // The fetch left a real remote-tracking ref behind, which is what tracking needs.
    expect(await repo.git(['rev-parse', 'refs/remotes/origin/spike/parser'])).toBe(remoteSha)
  })

  it('explains a start point that names nothing', async () => {
    const repo = await newRepo({ withRemote: true })

    const missing = await rejection(resolve(repo, 'origin/never-pushed'))
    expect(missing.code).toBe(ErrorCode.NotFound)
    expect(missing.message).toContain('origin/never-pushed')
    expect(missing.message).toContain('branch on origin')

    const nonsense = await rejection(resolve(repo, 'not-a-thing'))
    expect(nonsense.code).toBe(ErrorCode.NotFound)
    expect(nonsense.message).toContain('does not name a branch, tag, or commit')

    const malformed = await rejection(resolve(repo, '--upload-pack=evil'))
    expect(malformed.code).toBe(ErrorCode.InvalidParams)
  })
})

describe('worktree.create start points', () => {
  it('defaults to the project base ref and records the sha it actually used', async () => {
    const repo = await newRepo({ withRemote: true })
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const baseSha = await repo.git(['rev-parse', 'origin/main'])

    const pending = await service.createWorktree({ projectId: project.id, name: 'default start' })
    expect(pending.startedFrom).toBe('origin/main')
    const ready = await service.whenSettled(pending.id)

    expect(ready.state).toBe('ready')
    expect(ready.startedFrom).toBe(baseSha)
    expect(service.startPointFor(ready.id)).toMatchObject({ requested: 'origin/main', kind: 'remoteBranch' })
  })

  it('branches from a local branch, a tag, HEAD, and a detached sha', async () => {
    const repo = await newRepo()
    const first = await repo.git(['rev-parse', 'HEAD'])
    await repo.write('second.txt', 'second\n')
    await repo.commit('second commit')
    const second = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['branch', 'legacy', first])
    await repo.git(['tag', 'v0', first])

    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const started = async (name: string, startedFrom: string): Promise<string> => {
      const pending = await service.createWorktree({ projectId: project.id, name, startedFrom })
      const ready = await service.whenSettled(pending.id)
      if (ready.state !== 'ready') throw new Error(`create failed: ${ready.error ?? 'unknown'}`)
      expect(await repo.git(['rev-parse', 'HEAD'], ready.path)).toBe(ready.startedFrom)
      return ready.startedFrom
    }

    expect(await started('from branch', 'legacy')).toBe(first)
    expect(await started('from tag', 'v0')).toBe(first)
    expect(await started('from head', 'HEAD')).toBe(second)
    // A sha nothing points at: the start point is a commit, not a ref.
    expect(await started('from sha', first.slice(0, 10))).toBe(first)
  })

  // The branch it started from is history, not an upstream. Inheriting it as
  // one is what made "how much is left to push" keep counting commits the
  // remote already had: see `worktreePush.ts`, which sets the tracking to the
  // branch it actually wrote.
  it('records the remote branch it started from without tracking it', async () => {
    const repo = await newRepo({ withRemote: true })
    await pushFromElsewhere(repo, 'api-rewrite')
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({
      projectId: project.id,
      name: 'continue the api rewrite',
      startedFrom: 'origin/api-rewrite'
    })
    const ready = await service.whenSettled(pending.id)

    expect(ready.state).toBe('ready')
    const upstream = await repo.runner.tryRun({
      args: ['rev-parse', '--abbrev-ref', `${ready.branch}@{upstream}`],
      cwd: repo.repoPath,
      readOnly: true
    })
    expect(upstream.exitCode).not.toBe(0)
    expect(service.startPointFor(ready.id)?.track).toBe('origin/api-rewrite')
    expect(service.startPointFor(ready.id)?.fetched).toBe(true)
  })

  it('fails the worktree with a reason that names what was searched', async () => {
    const repo = await newRepo({ withRemote: true })
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({ projectId: project.id, name: 'doomed', startedFrom: 'nope' })
    const settled = await service.whenSettled(pending.id)

    expect(settled.state).toBe('failed')
    expect(settled.error).toContain('does not name a branch, tag, or commit')
    expect(settled.startedFrom).toBe('nope') // still the request; nothing was resolved
    expect(service.startPointFor(settled.id)).toBeUndefined()
  })
})

describe('listStartPoints', () => {
  it('puts the base ref and the current branch first, then branches, remotes and tags', async () => {
    const repo = await newRepo({ withRemote: true })
    await repo.git(['branch', 'alpha'])
    await repo.git(['branch', 'beta'])
    await repo.git(['tag', 'v9'])
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const listed = await service.listStartPoints(project.id)

    expect(listed.baseRef).toBe('origin/main')
    expect(listed.options.map((option) => option.ref)).toEqual(['origin/main', 'main', 'alpha', 'beta', 'v9'])
    expect(listed.options.map((option) => option.kind)).toEqual([
      'remoteBranch',
      'localBranch',
      'localBranch',
      'localBranch',
      'tag'
    ])
    expect(listed.options[0]?.isBase).toBe(true)
    expect(listed.options[1]?.isCurrent).toBe(true)
    expect(listed.options.filter((option) => option.isBase)).toHaveLength(1)
    // origin/HEAD is a pointer at a row already in the list.
    expect(listed.options.some((option) => option.ref.endsWith('HEAD'))).toBe(false)
    expect(listed.truncated).toBe(false)
    expect(listed.total).toBe(listed.options.length)

    // The dialog can preview a choice before anything is created.
    expect(await service.describeStartPoint(project.id)).toMatchObject({
      requested: 'origin/main',
      kind: 'remoteBranch'
    })
    expect(await service.describeStartPoint(project.id, 'v9')).toMatchObject({ kind: 'tag' })

    const head = await repo.git(['rev-parse', 'HEAD'])
    for (const option of listed.options) {
      expect(option.sha).toBe(head)
      expect(option.shortSha.length).toBeGreaterThanOrEqual(4)
      expect(head.startsWith(option.shortSha)).toBe(true)
    }
  })

  it('caps the list and says that it capped it, keeping the base ref', async () => {
    const repo = await newRepo({ withRemote: true })
    for (let index = 0; index < 12; index += 1) await repo.git(['branch', `busy-${index}`])
    const service = newService(repo, { startPointLimit: 5 })
    const project = await service.addProject({ path: repo.repoPath })

    const listed = await service.listStartPoints(project.id)

    expect(listed.limit).toBe(5)
    expect(listed.options).toHaveLength(5)
    expect(listed.total).toBe(14) // main plus twelve branches, plus origin/main
    expect(listed.truncated).toBe(true)
    expect(listed.options[0]?.ref).toBe('origin/main')
    expect(listed.options[1]?.ref).toBe('main')

    // An explicit limit overrides the service default.
    expect((await service.listStartPoints(project.id, { limit: 100 })).truncated).toBe(false)
  })

  it('offers a detached HEAD as its own row', async () => {
    const repo = await newRepo()
    await repo.write('second.txt', 'second\n')
    await repo.commit('second commit')
    const head = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['checkout', '--detach'])
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const listed = await service.listStartPoints(project.id)

    const detached = listed.options.find((option) => option.kind === 'head')
    expect(detached).toMatchObject({ ref: 'HEAD', sha: head, isCurrent: true })
  })
})
