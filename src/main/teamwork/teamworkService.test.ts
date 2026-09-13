import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import type { GitRunner } from '../git/gitProcess'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { formatMemberFile } from './memberFile'
import { membersDirectory } from './roster'
import { TeamworkService } from './teamworkService'

const GRACE = 'tOZqe8RgnJt2KzVOWEfPkfYHQpB1i0Jt7Ojb9vDfjW4='

const repos: TempRepo[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Harness = {
  repo: TempRepo
  project: Project
  service: TeamworkService
  changes: number
  /** Puts somebody else's key in the repository, as a `git pull` would. */
  seed: (handle: string, publicKey: string) => Promise<void>
}

/**
 * A git that has no email to give. Unsetting it in the repository is not
 * enough: the machine running the suite has a global config, and the point of
 * these two tests is the machine that has never configured one at all.
 */
function withoutEmail(inner: GitRunner): GitRunner {
  const unset = (args: readonly string[]): boolean => args[0] === 'config' && args.includes('user.email')
  return {
    binary: inner.binary,
    run: (run) => inner.run(run),
    tryRun: (run) => (unset(run.args) ? Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }) : inner.tryRun(run))
  }
}

async function wire(options: { email?: string | null } = {}): Promise<Harness> {
  const repo = await createTempRepo()
  repos.push(repo)
  if (typeof options.email === 'string') await repo.git(['config', 'user.email', options.email])
  const runner = options.email === null ? withoutEmail(repo.runner) : repo.runner

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-teamwork-'))
  dirs.push(dataDir)

  const project: Project = { id: 'proj1', name: 'repo', path: repo.repoPath, baseRef: 'main' }
  const harness: Harness = {
    repo,
    project,
    changes: 0,
    service: new TeamworkService({
      store: { getProject: (id) => (id === project.id ? project : undefined) },
      dataDir,
      runner,
      now: () => Date.parse('2026-09-13T10:00:00Z'),
      onRosterChange: () => {
        harness.changes += 1
      }
    }),
    seed: async (handle, publicKey) => {
      await mkdir(membersDirectory(repo.repoPath), { recursive: true })
      await writeFile(
        path.join(membersDirectory(repo.repoPath), `${handle}.pub`),
        formatMemberFile({ handle, publicKey, addedAt: '2026-01-04' }),
        'utf8'
      )
    }
  }
  return harness
}

describe('listing a project roster', () => {
  it('refuses unsigned enrollment when human verification is required', async () => {
    const { service, project, repo } = await wire({ email: 'alice@example.com' })
    const issuer = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
    await mkdir(path.join(repo.repoPath, '.teamree'), { recursive: true })
    await writeFile(
      path.join(repo.repoPath, '.teamree', 'human-policy.json'),
      JSON.stringify({ teamId: 'team', issuerPublicKey: issuer, revoked: [] })
    )
    await expect(service.joinProject({ projectId: project.id })).rejects.toThrow('requires human verification')
    expect((await service.listMembers({ projectId: project.id })).members).toEqual([])
  })
  it('says you are not in a roster you have not joined, and what you would be filed as', async () => {
    const { service, project } = await wire({ email: 'ada.lovelace@example.com' })

    const list = await service.listMembers({ projectId: project.id })

    expect(list.members).toEqual([])
    expect(list.enrolled).toBe(false)
    expect(list.self.handle).toBe('ada.lovelace')
    expect(list.selfFile).toBe('.teamree/members/ada.lovelace.pub')
  })

  it('still shows the team when it cannot work out what to call you', async () => {
    const harness = await wire({ email: null })
    await harness.seed('grace', GRACE)

    const list = await harness.service.listMembers({ projectId: harness.project.id })

    expect(list.members.map((member) => member.handle)).toEqual(['grace'])
    expect(list.self.handle).toBeNull()
    expect(list.selfFile).toBeNull()
  })

  it('marks exactly one entry as you, and it is the one with your key', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.seed('grace', GRACE)
    await harness.service.joinProject({ projectId: harness.project.id })

    const list = await harness.service.listMembers({ projectId: harness.project.id })

    expect(list.members.filter((member) => member.isSelf).map((member) => member.handle)).toEqual(['ada'])
    expect(list.enrolled).toBe(true)
  })

  it('calls you what the roster already files your key under, not what git would', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.service.joinProject({ projectId: harness.project.id, handle: 'lovelace' })

    const list = await harness.service.listMembers({ projectId: harness.project.id })

    expect(list.self.handle).toBe('lovelace')
    expect(list.enrolled).toBe(true)
  })

  it('reports a file it could not read without losing the members it could', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.seed('grace', GRACE)
    await writeFile(path.join(membersDirectory(harness.repo.repoPath), 'broken.pub'), 'nonsense\n', 'utf8')

    const list = await harness.service.listMembers({ projectId: harness.project.id })

    expect(list.members.map((member) => member.handle)).toEqual(['grace'])
    expect(list.problems.map((problem) => problem.file)).toEqual(['.teamree/members/broken.pub'])
  })

  it('refuses a project it has never heard of', async () => {
    const { service } = await wire()

    await expect(service.listMembers({ projectId: 'nope' })).rejects.toThrow(/no project with id/)
  })
})

describe('joining a project', () => {
  it('writes the key into the repository and leaves committing to the user', async () => {
    const harness = await wire({ email: 'ada@example.com' })

    const list = await harness.service.joinProject({ projectId: harness.project.id })

    expect(list.enrolled).toBe(true)
    const written = await readFile(path.join(harness.repo.repoPath, '.teamree/members/ada.pub'), 'utf8')
    expect(written).toContain('handle: ada')
    expect(written).toContain('added: 2026-09-13')
    // The file is sitting there untracked. Getting it into the repository is
    // the step that means something, so the app must not have taken it.
    expect(await harness.repo.git(['status', '--porcelain'])).toContain('.teamree/')
    expect(await harness.repo.git(['log', '--oneline'])).not.toContain('member')
  })

  it('announces the change, so a window showing the roster re-reads it', async () => {
    const harness = await wire({ email: 'ada@example.com' })

    await harness.service.joinProject({ projectId: harness.project.id })

    expect(harness.changes).toBe(1)
  })

  it('takes the handle it is given over the one git implies', async () => {
    const harness = await wire({ email: 'ada.lovelace@example.com' })

    const list = await harness.service.joinProject({ projectId: harness.project.id, handle: 'Ada!' })

    expect(list.members.map((member) => member.handle)).toEqual(['ada'])
  })

  it('does nothing the second time, rather than filing one key twice', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.service.joinProject({ projectId: harness.project.id })

    const again = await harness.service.joinProject({ projectId: harness.project.id, handle: 'somethingelse' })

    expect(again.members.map((member) => member.handle)).toEqual(['ada'])
    expect(harness.changes).toBe(1)
  })

  it('refuses to take a handle that already belongs to another key', async () => {
    const harness = await wire({ email: 'grace@example.com' })
    await harness.seed('grace', GRACE)

    const refusal = harness.service.joinProject({ projectId: harness.project.id })

    await expect(refusal).rejects.toThrow(/already somebody else's key/)
  })

  it('refuses to overwrite a file it could not read as a member', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await mkdir(membersDirectory(harness.repo.repoPath), { recursive: true })
    await writeFile(path.join(membersDirectory(harness.repo.repoPath), 'ada.pub'), 'half a key\n', 'utf8')

    const refusal = harness.service.joinProject({ projectId: harness.project.id })

    await expect(refusal).rejects.toThrow(/look at it before replacing it/)
    expect(await readFile(path.join(harness.repo.repoPath, '.teamree/members/ada.pub'), 'utf8')).toBe('half a key\n')
  })

  it('asks for a handle rather than inventing one when git has no email', async () => {
    const harness = await wire({ email: null })

    const refusal = harness.service.joinProject({ projectId: harness.project.id })

    await expect(refusal).rejects.toThrow(/choose a handle/)
  })

  it('says so when the handle it was given has nothing usable in it', async () => {
    const harness = await wire({ email: 'ada@example.com' })

    const refusal = harness.service.joinProject({ projectId: harness.project.id, handle: '///' })

    await expect(refusal).rejects.toThrow(/choose another handle/)
  })
})
