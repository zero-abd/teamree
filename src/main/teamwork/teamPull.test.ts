// Two people setting teamwork up against one bare origin, on the real git: the joiner's push
// lands without a hand-typed pull, and the leader sees them without one either.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import type { GitRunner } from '../git/gitProcess'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { TeamworkService } from './teamworkService'

const repos: TempRepo[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Side = {
  path: string
  project: Project
  service: TeamworkService
  git: (args: string[]) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  /** Commits everything given and pushes it, as a person at a terminal would. */
  commitAndPush: (files: Record<string, string>, message: string) => Promise<void>
}

type Pair = { leader: Side; joiner: Side; origin: string; repo: TempRepo }

/** Runs `before` once, just ahead of this side's first push: a teammate pushing in between. */
function pushingFirst(inner: GitRunner, before: () => Promise<void>): GitRunner {
  let done = false
  const hold = async (args: readonly string[]): Promise<void> => {
    if (done || args[0] !== 'push') return
    done = true
    await before()
  }
  return {
    binary: inner.binary,
    run: async (run) => (await hold(run.args), inner.run(run)),
    tryRun: async (run) => (await hold(run.args), inner.tryRun(run))
  }
}

async function side(repo: TempRepo, checkout: string, email: string, runner: GitRunner): Promise<Side> {
  await repo.git(['config', 'user.email', email], checkout)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-pull-'))
  dirs.push(dataDir)
  const project: Project = { id: 'proj1', name: 'repo', path: checkout, baseRef: 'origin/main' }
  const git = (args: string[]): Promise<string> => repo.git(args, checkout)
  const write = (file: string, text: string): Promise<void> => repo.write(file, text, checkout)
  return {
    path: checkout,
    project,
    service: new TeamworkService({
      store: { getProject: () => project },
      dataDir,
      runner,
      now: () => Date.UTC(2026, 8, 26)
    }),
    git,
    write,
    async commitAndPush(files, message) {
      for (const [file, text] of Object.entries(files)) await write(file, text)
      await git(['add', '--', ...Object.keys(files)])
      await git(['commit', '--no-verify', '-m', message, '--', ...Object.keys(files)])
      await git(['push', 'origin', 'main'])
    }
  }
}

/** Ada has started a team and pushed it; Sam has cloned it and not joined yet. */
async function pair(
  options: { joinerRunner?: (inner: GitRunner, leader: () => Side) => GitRunner } = {}
): Promise<Pair> {
  const repo = await createTempRepo({ withRemote: true })
  repos.push(repo)
  const origin = path.join(repo.base, 'origin.git')
  const leader = await side(repo, repo.repoPath, 'ada@example.com', repo.runner)
  await leader.service.joinProject({ projectId: leader.project.id })
  await leader.service.setRelay({ projectId: leader.project.id, url: 'wss://relay.example/v1/relay' })
  expect((await leader.service.publish({ projectId: leader.project.id })).push.ok).toBe(true)

  const clone = path.join(repo.base, 'sam')
  await repo.git(['clone', origin, clone], repo.base)
  await repo.git(['config', 'user.name', 'Sam'], clone)
  await repo.git(['config', 'commit.gpgsign', 'false'], clone)
  const runner = options.joinerRunner?.(repo.runner, () => leader) ?? repo.runner
  const joiner = await side(repo, clone, 'sam@example.com', runner)
  return { leader, joiner, origin, repo }
}

/** Everything uncommitted in a checkout, byte for byte. */
async function uncommitted(one: Side, files: string[]): Promise<string[]> {
  return [
    await one.git(['status', '--porcelain=v1', '--untracked-files=all']),
    await one.git(['diff']),
    await one.git(['diff', '--cached']),
    ...(await Promise.all(files.map((file) => readFile(path.join(one.path, file), 'utf8'))))
  ]
}

/** Staged, unstaged and untracked work, in files no teammate's commit touches. */
async function workInProgress(one: Side): Promise<string[]> {
  await one.write('README.md', '# fixture\nstaged edit\n')
  await one.git(['add', 'README.md'])
  await one.write('README.md', '# fixture\nstaged edit\nunstaged edit\n')
  await one.write('scratch.txt', 'untracked\n')
  return ['README.md', 'scratch.txt']
}

async function originFiles(pairing: Pair): Promise<string[]> {
  const listed = await pairing.repo.git(['ls-tree', '-r', '--name-only', 'main'], pairing.origin)
  return listed.split('\n')
}

describe('joining while the leader has pushed newer commits', () => {
  it('pulls them in first and ends pushed, with nothing typed by hand', async () => {
    const pairing = await pair()
    const { leader, joiner } = pairing
    await leader.commitAndPush({ 'NOTES.md': 'from ada\n' }, 'Notes')

    await joiner.service.joinProject({ projectId: joiner.project.id })
    const result = await joiner.service.publish({ projectId: joiner.project.id })

    expect(result.push.ok).toBe(true)
    expect(await originFiles(pairing)).toEqual(expect.arrayContaining(['NOTES.md', '.teamree/members/sam.pub']))
    expect(await joiner.git(['rev-parse', 'HEAD'])).toBe(await joiner.git(['rev-parse', 'origin/main']))
  })
})

describe('a push the remote turns away because a teammate pushed first', () => {
  it('rebuilds the teamwork commit on top of theirs and pushes again', async () => {
    const pairing = await pair({
      joinerRunner: (inner, leader) =>
        pushingFirst(inner, () => leader().commitAndPush({ 'NOTES.md': 'raced\n' }, 'Raced'))
    })
    const { joiner } = pairing

    await joiner.service.joinProject({ projectId: joiner.project.id })
    const result = await joiner.service.publish({ projectId: joiner.project.id })

    expect(result.push.ok).toBe(true)
    expect(await joiner.git(['log', '-1', '--format=%s'])).toBe('Set up teamwork')
    expect(await joiner.git(['log', '-1', '--format=%s', 'HEAD^'])).toBe('Raced')
    expect(await originFiles(pairing)).toEqual(expect.arrayContaining(['NOTES.md', '.teamree/members/sam.pub']))
  })

  it('says it in one line when both sides changed the same file, and keeps the commit', async () => {
    const pairing = await pair({
      joinerRunner: (inner, leader) =>
        pushingFirst(inner, () =>
          leader().commitAndPush({ '.teamree/relay': 'wss://ada.example/v1/relay\n' }, 'Move the relay')
        )
    })
    const { joiner } = pairing
    await joiner.service.joinProject({ projectId: joiner.project.id })
    await joiner.service.setRelay({ projectId: joiner.project.id, url: 'wss://sam.example/v1/relay' })

    const result = await joiner.service.publish({ projectId: joiner.project.id })

    expect(result.push.ok).toBe(false)
    if (result.push.ok) return
    expect(result.push.kind).toBe('rejected')
    expect(result.push.advice).toBe('Push rejected: .teamree/relay changed on origin too')
    expect(result.push.error).toMatch(/rejected/)
    expect(await joiner.git(['log', '-1', '--format=%s'])).toBe('Set up teamwork')

    const pulled = await joiner.service.pull({ projectId: joiner.project.id })
    expect(pulled).toMatchObject({ ok: false, moved: false, problem: 'Conflict in .teamree/relay' })
  })

  it('touches no uncommitted work, and says so when that work is in the way', async () => {
    const pairing = await pair({
      joinerRunner: (inner, leader) =>
        pushingFirst(inner, () => leader().commitAndPush({ 'README.md': '# theirs\n' }, 'Retitle'))
    })
    const { joiner } = pairing
    const files = await workInProgress(joiner)
    const before = await uncommitted(joiner, files)

    await joiner.service.joinProject({ projectId: joiner.project.id })
    const result = await joiner.service.publish({ projectId: joiner.project.id })

    expect(result.push.ok).toBe(false)
    if (!result.push.ok) expect(result.push.advice).toBe('Push rejected: local changes to README.md are in the way')
    expect(await uncommitted(joiner, files)).toEqual(before)
  })
})

describe('the leader, once somebody has joined', () => {
  it('sees the new member after a fetch, with no pull typed', async () => {
    const { leader, joiner } = await pair()
    await joiner.service.joinProject({ projectId: joiner.project.id })
    expect((await joiner.service.publish({ projectId: joiner.project.id })).push.ok).toBe(true)
    expect((await leader.service.listMembers({ projectId: leader.project.id })).members).toHaveLength(1)

    expect(await leader.service.refresh(leader.project.id)).toBe('moved')

    const list = await leader.service.listMembers({ projectId: leader.project.id })
    expect(list.members.map((member) => member.handle)).toEqual(['ada', 'sam'])
    expect(list.incoming ?? []).toEqual([])
  })

  it('leaves a branch with commits of its own alone, names who is waiting, and pulls on request', async () => {
    const { leader, joiner } = await pair()
    await joiner.service.joinProject({ projectId: joiner.project.id })
    await joiner.service.publish({ projectId: joiner.project.id })
    await leader.write('mine.txt', 'ada’s own\n')
    await leader.git(['add', 'mine.txt'])
    await leader.git(['commit', '--no-verify', '-m', 'Mine'])
    const files = await workInProgress(leader)
    const before = await uncommitted(leader, files)

    const head = await leader.git(['rev-parse', 'HEAD'])

    await leader.service.refresh(leader.project.id)
    expect(await leader.git(['rev-parse', 'HEAD'])).toBe(head)
    const waiting = await leader.service.listMembers({ projectId: leader.project.id })
    expect(waiting.members.map((member) => member.handle)).toEqual(['ada'])
    expect(waiting.incoming).toEqual(['sam'])

    expect(await leader.service.pull({ projectId: leader.project.id })).toMatchObject({ ok: true, moved: true })
    const list = await leader.service.listMembers({ projectId: leader.project.id })
    expect(list.members.map((member) => member.handle)).toEqual(['ada', 'sam'])
    expect(await leader.git(['log', '-1', '--format=%s'])).toBe('Mine')
    expect(await uncommitted(leader, files)).toEqual(before)
  })

  it('does not fast-forward the checkout over anything but .teamree in the background', async () => {
    const { leader, joiner } = await pair()
    await joiner.service.joinProject({ projectId: joiner.project.id })
    await joiner.service.publish({ projectId: joiner.project.id })
    await joiner.commitAndPush({ 'app.ts': 'export {}\n' }, 'Code')
    const head = await leader.git(['rev-parse', 'HEAD'])

    await leader.service.refresh(leader.project.id)

    expect(await leader.git(['rev-parse', 'HEAD'])).toBe(head)
    expect((await leader.service.listMembers({ projectId: leader.project.id })).incoming).toEqual(['sam'])
  })
})
