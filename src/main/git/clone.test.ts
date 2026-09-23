import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repositoryNameFromUrl } from '../../shared/cloneDestination'
import { ErrorCode } from '../../shared/protocol'
import { cloneDestination, cloneFailureKind, cloneFailureLine } from './clone'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/** A repository with a bare `origin.git` beside it: the only thing these tests ever clone. */
async function bareOrigin(): Promise<{ repo: TempRepo; origin: string; service: GitService }> {
  const repo = await createTempRepo({ withRemote: true })
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  return { repo, origin: path.join(repo.base, 'origin.git'), service }
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

describe('where a clone goes', () => {
  it('names the folder the way git does', () => {
    expect(repositoryNameFromUrl('https://github.com/acme/api.git')).toBe('api')
    expect(repositoryNameFromUrl('https://github.com/acme/api/')).toBe('api')
    expect(repositoryNameFromUrl('git@github.com:acme/api.git')).toBe('api')
    expect(repositoryNameFromUrl('/srv/git/api.git')).toBe('api')
    expect(repositoryNameFromUrl('')).toBe('')
  })

  it('defaults to ~/code/<repo>, expands ~, and refuses a relative path', () => {
    expect(cloneDestination('git@github.com:acme/api.git', undefined, '/Users/ada')).toBe('/Users/ada/code/api')
    expect(cloneDestination('https://x/api.git', '~/src/api', '/Users/ada')).toBe('/Users/ada/src/api')
    expect(cloneDestination('https://x/api.git', '/tmp/api', '/Users/ada')).toBe('/tmp/api')
    expect(() => cloneDestination('https://x/api.git', 'api', '/Users/ada')).toThrow(/absolute/)
  })
})

describe('what a failed clone says', () => {
  it('is one line per kind, and none of them a credential prompt', () => {
    const auth = "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    expect(cloneFailureKind(auth)).toBe('auth')
    expect(cloneFailureLine('auth', auth)).toBe('Authentication failed')
    expect(
      cloneFailureKind("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found")
    ).toBe('not-found')
    expect(cloneFailureKind("fatal: repository '/nope' does not exist")).toBe('not-found')
    expect(cloneFailureKind("fatal: destination path '/tmp/api' already exists and is not an empty directory.")).toBe(
      'exists'
    )
    expect(cloneFailureKind('Host key verification failed.')).toBe('host-key')
    expect(cloneFailureLine('other', 'Cloning into x...\nfatal: unable to access: SSL error\n')).toBe(
      'unable to access: SSL error'
    )
  })
})

describe('project.clone', () => {
  it('clones a local bare repository and adds it as a project', async () => {
    const { repo, origin, service } = await bareOrigin()
    const into = path.join(repo.base, 'clones', 'api')

    const project = await service.cloneProject({ url: origin, path: into, name: 'API' })

    expect(project.name).toBe('API')
    expect(project.baseRef).toBe('origin/main')
    expect(existsSync(path.join(into, 'README.md'))).toBe(true)
    expect(service.listProjects().map((entry) => entry.id)).toEqual([project.id])
    expect(service.cloneProgress({ url: origin })).toBeNull()
  })

  it('refuses a destination that already has something in it, and leaves it alone', async () => {
    const { repo, origin, service } = await bareOrigin()
    const into = path.join(repo.base, 'taken')
    await mkdir(into)
    await writeFile(path.join(into, 'keep.txt'), 'mine\n')

    const error = await rejection(service.cloneProject({ url: origin, path: into }))

    expect(error.message).toBe('Destination exists')
    expect(error.code).toBe(ErrorCode.Conflict)
    expect(existsSync(path.join(into, 'keep.txt'))).toBe(true)
    expect(service.listProjects()).toEqual([])
  })

  it('says a missing repository is not found', async () => {
    const { repo, service } = await bareOrigin()
    const error = await rejection(
      service.cloneProject({ url: path.join(repo.base, 'nowhere.git'), path: path.join(repo.base, 'n') })
    )
    expect(error.message).toBe('Repository not found')
    expect(error.code).toBe(ErrorCode.NotFound)
  })

  it('never runs a transport git would hand to a program', async () => {
    const { repo, service } = await bareOrigin()
    const error = await rejection(
      service.cloneProject({ url: 'ext::sh -c touch% /tmp/pwned', path: path.join(repo.base, 'x') })
    )
    expect(error.code).toBe(ErrorCode.InvalidParams)
  })

  it('reports progress while it runs, and a cancel stops it and leaves nothing behind', async () => {
    const { repo, origin } = await bareOrigin()
    // Holds the clone until it is aborted, as a slow network would.
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const inner = repo.runner
    const runner: GitRunner = {
      binary: inner.binary,
      run: (run) => inner.run(run),
      async tryRun(run) {
        if (run.args[0] !== 'clone') return inner.tryRun(run)
        run.onStderr?.('Receiving objects:  12% (1/8)\r')
        started()
        await new Promise((resolve) => run.signal?.addEventListener('abort', resolve, { once: true }))
        return inner.tryRun(run)
      }
    }
    const service = new GitService({ worktreesRoot: repo.worktreesRoot, runner })
    services.push(service)
    const into = path.join(repo.base, 'slow')

    const cloning = rejection(service.cloneProject({ url: origin, path: into }))
    await running
    expect(service.cloneProgress({ url: origin })).toMatchObject({
      url: origin,
      path: into,
      line: 'Receiving objects:  12% (1/8)',
      cancelling: false
    })
    await expect(rejection(service.cloneProject({ url: origin, path: into }))).resolves.toMatchObject({
      message: 'Already cloning'
    })

    expect(service.cancelClone({ url: origin })).toEqual({ cancelled: true })
    expect((await cloning).message).toBe('Clone cancelled')
    expect(existsSync(into)).toBe(false)
    expect(service.cancelClone({ url: origin })).toEqual({ cancelled: false })
    expect(service.listProjects()).toEqual([])
  })
})
