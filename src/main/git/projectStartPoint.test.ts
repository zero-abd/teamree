import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo, type TempRepoOptions } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function setUp(
  options?: TempRepoOptions,
  before?: (repo: TempRepo) => Promise<void>
): Promise<{ repo: TempRepo; service: GitService; projectId: string }> {
  const repo = await createTempRepo(options)
  repos.push(repo)
  await before?.(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, projectId: project.id }
}

async function refusal(promise: Promise<unknown>): Promise<GitServiceError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(GitServiceError)
  return error as GitServiceError
}

describe("a project's start point", () => {
  it('is where a create without a ref starts', async () => {
    const { repo, service, projectId } = await setUp({ withRemote: true })
    await repo.git(['branch', 'release'])
    await repo.write('later.txt', 'later\n')
    await repo.commit('after the release branch')
    const release = await repo.git(['rev-parse', 'release'])

    const saved = await service.setProjectPaths({ projectId, startPoint: ' release ' })
    expect(saved.startPoint).toBe('release')

    const pending = await service.createWorktree({ projectId, name: 'from the setting' })
    expect(pending.startedFrom).toBe('release')
    const ready = await service.whenSettled(pending.id)
    expect(ready.state).toBe('ready')
    expect(ready.startedFrom).toBe(release)
    expect(ready.startedFromRef).toBe('release')

    // An explicit ref still wins.
    const explicit = await service.whenSettled(
      (await service.createWorktree({ projectId, name: 'from main', startedFrom: 'main' })).id
    )
    expect(explicit.startedFromRef).toBe('main')
  })

  it("falls back to the repository's startFrom, then the base ref", async () => {
    const { service, projectId } = await setUp({}, async (repo) => {
      await repo.git(['branch', 'integration'])
      await repo.write('.teamree/project.json', '{"startFrom": "integration"}')
      await repo.commit('share the start point')
    })
    expect((await service.createWorktree({ projectId, name: 'shared start' })).startedFrom).toBe('integration')

    const { service: plain, projectId: plainId } = await setUp()
    expect((await plain.createWorktree({ projectId: plainId, name: 'base start' })).startedFrom).toBe('main')
  })

  it('refuses a ref that does not resolve, and keeps the one it had', async () => {
    const { repo, service, projectId } = await setUp({ withRemote: true })
    await repo.git(['branch', 'release'])
    await service.setProjectPaths({ projectId, startPoint: 'release' })

    const refused = await refusal(service.setProjectPaths({ projectId, startPoint: 'origin/mainmain~2' }))
    expect(refused.code).toBe(ErrorCode.NotFound)
    expect(refused.message).toBe('origin/mainmain~2 · no such ref')

    const [project] = await service.listProjects()
    expect(project?.startPoint).toBe('release')
  })

  it('fetches a remote-tracking ref before judging it', async () => {
    const { repo, service, projectId } = await setUp({ withRemote: true })
    await repo.git(['push', 'origin', 'main:refs/heads/hotfix'])
    await repo.git(['update-ref', '-d', 'refs/remotes/origin/hotfix'])

    const saved = await service.setProjectPaths({ projectId, startPoint: 'origin/hotfix' })
    expect(saved.startPoint).toBe('origin/hotfix')
    expect(await repo.git(['rev-parse', '--verify', 'refs/remotes/origin/hotfix'])).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('is cleared by an empty string', async () => {
    const { repo, service, projectId } = await setUp()
    await repo.git(['branch', 'release'])
    await service.setProjectPaths({ projectId, startPoint: 'release' })
    const cleared = await service.setProjectPaths({ projectId, startPoint: '' })
    expect(cleared.startPoint).toBeUndefined()
    expect((await service.createWorktree({ projectId, name: 'from base' })).startedFrom).toBe('main')
  })

  it('fails a create naming the ref once it stops resolving, never falling back', async () => {
    const { repo, service, projectId } = await setUp()
    await repo.git(['branch', 'release'])
    await service.setProjectPaths({ projectId, startPoint: 'release' })
    await repo.git(['branch', '-D', 'release'])

    const pending = await service.createWorktree({ projectId, name: 'after the branch went' })
    const failed = await service.whenSettled(pending.id)
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('"release"')
    expect(failed.error).toContain('no longer resolves')
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).toEqual(['main'])
  })

  it('is what Save to Repository writes when none is given', async () => {
    const { repo, service, projectId } = await setUp()
    await repo.git(['branch', 'release'])
    await service.setProjectPaths({ projectId, startPoint: 'release' })
    const { project } = await service.saveProjectSettings({ projectId })
    expect(project.repository?.startFrom).toBe('release')
  })
})
