import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function wire(
  options: {
    email?: string | null
    env?: NodeJS.ProcessEnv
    watching?: boolean
    /** Gives the checkout a bare `origin` on disk, as a clone would have. */
    withRemote?: boolean
    relayDeploy?: { command: string; reason: null } | { command: null; reason: string }
  } = {}
): Promise<Harness> {
  const repo = await createTempRepo(options.withRemote ? { withRemote: true } : {})
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
      env: options.env ?? {},
      watching: () => options.watching ?? false,
      relayDeploy: () => options.relayDeploy ?? { command: '/somewhere/relay/teamree-relay deploy', reason: null },
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

describe('a roster that changed on disk', () => {
  it('sees a teammate’s key arrive by pulling it, without being restarted', async () => {
    // The belt-and-braces half of the watch on `.teamree`: opening the dialog
    // is itself a read, and a read that finds the directory has moved has to
    // tell the rest of the app, or the sidebar goes on showing yesterday.
    const harness = await wire({ email: 'ada@example.com' })
    await harness.service.joinProject({ projectId: harness.project.id })
    expect(harness.changes).toBe(1)

    await harness.seed('grace', GRACE)
    const list = await harness.service.listMembers({ projectId: harness.project.id })

    expect(list.members.map((member) => member.handle)).toEqual(['ada', 'grace'])
    expect(harness.changes).toBe(2)
  })

  it('announces nothing when a read finds the roster it already knew', async () => {
    // Otherwise the announcement causes a re-read, which announces: the window
    // and the runtime would chase each other for as long as the app ran.
    const harness = await wire({ email: 'ada@example.com' })
    await harness.seed('grace', GRACE)

    await harness.service.listMembers({ projectId: harness.project.id })
    await harness.service.listMembers({ projectId: harness.project.id })

    expect(harness.changes).toBe(0)
  })

  it('says a roster nothing is watching is only as fresh as this read', async () => {
    const unwatched = await wire({ email: 'ada@example.com' })
    const watched = await wire({ email: 'ada@example.com', watching: true })

    expect((await unwatched.service.listMembers({ projectId: unwatched.project.id })).watched).toBe(false)
    expect((await watched.service.listMembers({ projectId: watched.project.id })).watched).toBe(true)
  })
})

describe('the relay a project meets on', () => {
  it('writes the file people were writing by hand, and leaves committing to them', async () => {
    const harness = await wire({ email: 'ada@example.com' })

    const setting = await harness.service.setRelay({
      projectId: harness.project.id,
      url: 'wss://relay.example/v1/relay'
    })

    expect(setting.url).toBe('wss://relay.example/v1/relay')
    expect(setting.source).toBe('repository')
    const written = await readFile(path.join(harness.repo.repoPath, '.teamree/relay'), 'utf8')
    expect(written).toContain('wss://relay.example/v1/relay')
    // Untracked, exactly like a member file: pushing it is what makes it the
    // team's, and the app must not have taken that step.
    expect(await harness.repo.git(['status', '--porcelain'])).toContain('.teamree/')
    expect(harness.changes).toBe(1)
  })

  it('refuses the address a deploy printed, and says what to type instead', async () => {
    const harness = await wire({ email: 'ada@example.com' })

    const refusal = harness.service.setRelay({
      projectId: harness.project.id,
      url: 'https://teamree-relay.example.workers.dev'
    })

    await expect(refusal).rejects.toThrow(/wss:\/\/teamree-relay\.example\.workers\.dev\/v1\/relay/)
  })

  it('says the environment was looked at and had nothing in it', async () => {
    // The answer to "I set the variable and nothing happened": an app opened
    // from Finder inherits no shell environment, and until now nothing in the
    // app could say whether the override had been seen at all.
    const harness = await wire({ email: 'ada@example.com', env: {} })

    const setting = await harness.service.readRelay({ projectId: harness.project.id })

    expect(setting.override).toEqual({ name: 'TEAMREE_RELAY_URL', value: null })
    expect(setting.url).toBeNull()
    expect(setting.problem).toContain('.teamree/relay')
  })

  it('shows the relay this checkout holds as well as the override beating it', async () => {
    const harness = await wire({
      email: 'ada@example.com',
      env: { TEAMREE_RELAY_URL: 'ws://127.0.0.1:8787/v1/relay' }
    })
    await harness.service.setRelay({ projectId: harness.project.id, url: 'wss://relay.example/v1/relay' })

    const setting = await harness.service.readRelay({ projectId: harness.project.id })

    expect(setting.url).toBe('ws://127.0.0.1:8787/v1/relay')
    expect(setting.source).toBe('environment')
    expect(setting.onDisk.url).toBe('wss://relay.example/v1/relay')
  })
})

// --- the three things that used to be shell commands in a panel -------------

describe('adding the origin remote', () => {
  it('sets it, and says it added rather than replaced one', async () => {
    const { service, project, repo } = await wire({ email: 'ada@example.com' })

    const result = await service.setOrigin({ projectId: project.id, url: 'https://github.com/ada/pager.git' })

    expect(result).toMatchObject({ remote: 'origin', url: 'https://github.com/ada/pager.git', replaced: false })
    expect(await repo.git(['remote', 'get-url', 'origin'])).toBe('https://github.com/ada/pager.git')
  })

  // Two layers, pinned separately and on purpose.
  //
  // `checkOrigin` refuses a URL beginning with `-`, and that is the whole of
  // what has kept an option out of git's argv. But it lives three calls away
  // from the command, and a defence that cannot be seen from the call site is
  // one that lasts exactly until somebody relaxes it for a good reason. So the
  // call site passes `--` as well, and both halves are asserted here — the
  // refusal, and that the separator genuinely makes git read such a value as
  // data. A separator that quietly did not work for this subcommand would be
  // worse than none, because it would look like defence and be decoration.
  it('refuses an origin that is really a flag, and hands git a separator so it could not be one', async () => {
    const { service, project, repo } = await wire({})

    await expect(service.setOrigin({ projectId: project.id, url: '--upload-pack=notacommand' })).rejects.toThrow(
      /not an origin teamree can use/
    )

    // The call site itself, read off what git was actually handed. Asserting
    // git's behaviour with a separator typed here by hand would have proved
    // something about git and nothing about this service — the first version of
    // this test did exactly that, and deleting the separator from the service
    // left it green.
    const asked: string[][] = []
    const watched = new TeamworkService({
      store: { getProject: (id) => (id === project.id ? project : undefined) },
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'teamree-argv-')),
      runner: {
        ...repo.runner,
        tryRun: async (request) => {
          asked.push([...request.args])
          return repo.runner.tryRun(request)
        }
      },
      now: () => Date.parse('2026-09-13T10:00:00Z'),
      env: {},
      watching: () => false,
      relayDeploy: () => ({ command: '/somewhere/relay/teamree-relay deploy', reason: null })
    })
    await watched.setOrigin({ projectId: project.id, url: 'https://github.com/ada/pager.git' })

    const wrote = asked.find((args) => args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url'))
    expect(wrote).toBeDefined()
    // Immediately before the two operands, which is the only position that
    // means "everything after this is data".
    expect(wrote?.[2]).toBe('--')
    expect(wrote?.at(-1)).toBe('https://github.com/ada/pager.git')

    // And git really does accept it there, for both spellings of the command —
    // a separator that were silently unsupported would look like defence and be
    // decoration.
    // `set-url` here rather than `add`, because the call above has just made an
    // origin — which is itself the state this service meets most often.
    await repo.git(['remote', 'set-url', '--', 'origin', '--upload-pack=notacommand'])
    expect(await repo.git(['remote', 'get-url', 'origin'])).toBe('--upload-pack=notacommand')
    await repo.git(['remote', 'remove', 'origin'])
    await repo.git(['remote', 'add', '--', 'origin', '-also-a-flag'])
    expect(await repo.git(['remote', 'get-url', 'origin'])).toBe('-also-a-flag')
  })

  // The whole reason somebody reaches this is an origin teamree cannot compare.
  // "There is already an origin" would be the app naming the problem and
  // declining to fix it — so it replaces, and says so.
  it('replaces one that is already there, and reports that it did', async () => {
    const { service, project, repo } = await wire({ withRemote: true })

    const result = await service.setOrigin({ projectId: project.id, url: 'ssh://git@example.com/ada/pager.git' })

    expect(result.replaced).toBe(true)
    expect(await repo.git(['remote', 'get-url', 'origin'])).toBe('ssh://git@example.com/ada/pager.git')
  })

  // A path is a perfectly good git remote and a useless project identity,
  // because nobody else can clone it. Refused before git is ever run.
  // A repository on a shared volume is a remote everybody really can reach, so
  // the path is set — normalised, because those characters are the project's
  // identity and a teammate has to be given them exactly.
  it('sets the path a shared repository is mounted at, in its normalised spelling', async () => {
    const { service, project, repo } = await wire()

    const result = await service.setOrigin({ projectId: project.id, url: '/Volumes/team/pager.git/' })
    expect(result).toMatchObject({ url: '/Volumes/team/pager.git', replaced: false })
    expect(await repo.git(['remote', 'get-url', 'origin'])).toBe('/Volumes/team/pager.git')
  })

  it('refuses a path no two machines could agree on, and touches nothing', async () => {
    const { service, project, repo } = await wire()

    await expect(service.setOrigin({ projectId: project.id, url: '~/code/pager' })).rejects.toThrow(
      /~ is a different directory/
    )
    await expect(service.setOrigin({ projectId: project.id, url: '../pager' })).rejects.toThrow(/relative path/)
    expect(await repo.git(['remote'])).toBe('')
  })

  it('refuses anything that is neither', async () => {
    const { service, project } = await wire()
    await expect(service.setOrigin({ projectId: project.id, url: 'pager' })).rejects.toThrow(
      /neither a URL with a host in it/
    )
  })

  // The step goes green without a restart because the status is re-read, and it
  // is re-read because something told the window that `.teamree` moved.
  it('announces the change, so the blocked step is asked about again', async () => {
    const harness = await wire()
    const before = harness.changes

    await harness.service.setOrigin({ projectId: harness.project.id, url: 'https://example.com/ada/pager.git' })

    expect(harness.changes).toBe(before + 1)
  })
})

describe('what committing and pushing would do', () => {
  it('names nothing to do when neither file has been written', async () => {
    const { service, project } = await wire({ withRemote: true })

    const plan = await service.publishPlan({ projectId: project.id })

    expect(plan.files).toEqual([])
    expect(plan.blocker).toMatch(/nothing to push yet/)
  })

  it('names the files, the message, the remote and the branch', async () => {
    const harness = await wire({ email: 'ada@example.com', withRemote: true })
    await harness.service.joinProject({ projectId: harness.project.id })
    await harness.service.setRelay({ projectId: harness.project.id, url: 'wss://relay.example/v1/relay' })

    const plan = await harness.service.publishPlan({ projectId: harness.project.id })

    expect(plan.files).toEqual(['.teamree/members/ada.pub', '.teamree/relay'])
    expect(plan.message).toBe('Set up teamwork')
    expect(plan.remote).toBe('origin')
    expect(plan.branch).toBe('main')
    expect(plan.committed).toBe(false)
    expect(plan.blocker).toBeNull()
  })

  // A button that looks live and then explains itself only once it is pressed
  // is the thing this whole change exists to remove.
  it('says a repository with no remote cannot push, and names where to fix it', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.service.joinProject({ projectId: harness.project.id })

    const plan = await harness.service.publishPlan({ projectId: harness.project.id })

    expect(plan.blocker).toMatch(/no origin remote/)
  })
})

describe('committing and pushing', () => {
  it('commits exactly the two files and sends them, naming what the branch tracks', async () => {
    const harness = await wire({ email: 'ada@example.com', withRemote: true })
    await harness.service.joinProject({ projectId: harness.project.id })
    await harness.service.setRelay({ projectId: harness.project.id, url: 'wss://relay.example/v1/relay' })

    const result = await harness.service.publish({ projectId: harness.project.id })

    expect(result.commit).not.toBeNull()
    expect(result.push).toMatchObject({ ok: true, upstream: 'origin/main' })
    const committed = await harness.repo.git(['show', '--name-only', '--format=', 'HEAD'])
    expect(committed.split('\n').sort()).toEqual(['.teamree/members/ada.pub', '.teamree/relay'])
  })

  // `git add -A` would sweep somebody's half-finished work into a commit they
  // never asked for. The paths are named, and the commit is path-limited too.
  it('leaves everything else exactly where it was, staged or not', async () => {
    const harness = await wire({ email: 'ada@example.com', withRemote: true })
    await harness.service.joinProject({ projectId: harness.project.id })
    await harness.repo.write('mine.txt', 'work in progress\n')
    await harness.repo.git(['add', 'mine.txt'])

    await harness.service.publish({ projectId: harness.project.id })

    const committed = await harness.repo.git(['show', '--name-only', '--format=', 'HEAD'])
    expect(committed.split('\n')).toEqual(['.teamree/members/ada.pub'])
    expect(await harness.repo.git(['diff', '--cached', '--name-only'])).toBe('mine.txt')
  })

  // A commit that landed and a push that was refused is the ordinary way this
  // goes wrong, and calling the whole thing a failure would leave somebody
  // believing no commit exists.
  it('reports the commit and git’s own words when the push is refused', async () => {
    const harness = await wire({ email: 'ada@example.com', withRemote: true })
    await harness.service.joinProject({ projectId: harness.project.id })
    // A remote that is not there at all: git refuses, and what it says about it
    // is the only thing worth printing.
    await harness.repo.git(['remote', 'set-url', 'origin', path.join(harness.repo.base, 'not-a-repo')])

    const result = await harness.service.publish({ projectId: harness.project.id })

    expect(result.commit).not.toBeNull()
    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.error).not.toBe('')
      expect(result.push.advice).not.toBe('')
    }
  })

  it('pushes without committing again when the files are already committed', async () => {
    const harness = await wire({ email: 'ada@example.com', withRemote: true })
    await harness.service.joinProject({ projectId: harness.project.id })
    await harness.service.publish({ projectId: harness.project.id })

    const again = await harness.service.publish({ projectId: harness.project.id })

    expect(again.commit).toBeNull()
    expect(again.push).toMatchObject({ ok: true, alreadyUpToDate: true })
  })

  it('refuses before touching anything when the plan said it could not be done', async () => {
    const harness = await wire({ email: 'ada@example.com' })
    await harness.service.joinProject({ projectId: harness.project.id })

    await expect(harness.service.publish({ projectId: harness.project.id })).rejects.toThrow(/no origin remote/)
    expect(await harness.repo.git(['status', '--porcelain'])).toMatch(/\.teamree/)
  })
})

describe('the command that stands a relay up', () => {
  it('is reported beside the relay, so the panel need not guess at a path', async () => {
    const { service, project } = await wire()

    const relay = await service.readRelay({ projectId: project.id })

    expect(relay.deploy).toEqual({ command: '/somewhere/relay/teamree-relay deploy', reason: null })
  })

  // A disabled button whose reason nobody can read is the same as one that does
  // nothing, so the reason travels with the absence.
  it('says why there is none, when this build carries none', async () => {
    const { service, project } = await wire({
      relayDeploy: { command: null, reason: 'this build does not carry the relay project' }
    })

    const relay = await service.readRelay({ projectId: project.id })

    expect(relay.deploy).toEqual({ command: null, reason: 'this build does not carry the relay project' })
  })
})
