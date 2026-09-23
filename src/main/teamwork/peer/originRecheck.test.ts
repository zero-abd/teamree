// Fixing `origin` has to be noticed by the next thing that asks. Nothing watches
// git's config, so before `refreshIfOriginMoved` a checkout that had its remote
// added went on being told to add one. Asked through the dispatcher.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { TeamworkRead, TeamworkStatus } from '../../../shared/entities'
import { createGitRunner } from '../../git/gitProcess'
import { createTempRepo, type TempRepo } from '../../git/testRepository'
import { createManualScheduler, createPeerRuntime, project, type PeerRuntime } from './peerTestSupport'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** The real git binary against a real checkout: the question here is git's. */
async function runtimeFor(repo: TempRepo): Promise<PeerRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-origin-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  return createPeerRuntime({
    workspace: { projects: [project('p_one', repo.repoPath)], worktrees: [], terminals: [] },
    dial: () => {
      throw new Error('this test never reaches a relay')
    },
    scheduler: createManualScheduler(),
    runner: createGitRunner(),
    dataDir,
    env: {}
  })
}

let asked = 0

/**
 * Asked the way the panel asks, and insisting on a read: an unread answer would
 * mean the reconcile behind `start()` did not happen.
 */
async function status(runtime: PeerRuntime): Promise<TeamworkRead> {
  asked += 1
  const response = await runtime.dispatch(
    { id: `status_${asked}`, method: 'teamwork.status', params: { projectId: 'p_one' } },
    { connectionId: 'window' }
  )
  if (!('ok' in response) || response.ok !== true) throw new Error(JSON.stringify(response))
  const result = response.result as TeamworkStatus
  if (result.state !== 'read') throw new Error('teamwork has not read p_one yet')
  return result
}

it('reports an origin set after the last reconcile, without an unrelated event', async () => {
  const repo = await createTempRepo()
  cleanups.push(() => repo.cleanup())
  // A remote git cannot be asked to compare: the state the panel blocks on.
  await repo.git(['remote', 'add', 'origin', 'not a url'])

  const runtime = await runtimeFor(repo)
  await runtime.service.start()

  const before = await status(runtime)
  expect(before.origin.ok).toBe(false)
  expect(before.disabledReason).not.toBeNull()

  await repo.git(['remote', 'set-url', 'origin', 'https://example.invalid/team/app.git'])

  // No restart, no roster change, no project added: the next read is all that happens.
  const after = await status(runtime)
  // The URL comes back with the verdict, so the invitation on the setup page
  // can say what to clone.
  expect(after.origin).toEqual({ ok: true, url: 'https://example.invalid/team/app.git' })
})

it('notices a remote removed as readily as one added', async () => {
  const repo = await createTempRepo()
  cleanups.push(() => repo.cleanup())
  await repo.git(['remote', 'add', 'origin', 'https://example.invalid/team/app.git'])

  const runtime = await runtimeFor(repo)
  await runtime.service.start()
  expect((await status(runtime)).origin.ok).toBe(true)

  await repo.git(['remote', 'remove', 'origin'])
  expect((await status(runtime)).origin.ok).toBe(false)
})

it('asks git again only when the config moved', async () => {
  const repo = await createTempRepo()
  cleanups.push(() => repo.cleanup())
  await repo.git(['remote', 'add', 'origin', 'https://example.invalid/team/app.git'])

  let originReads = 0
  const real = createGitRunner()
  const counting = {
    ...real,
    tryRun: (run: Parameters<typeof real.tryRun>[0]) => {
      if (run.args.join(' ') === 'remote get-url origin') originReads += 1
      return real.tryRun(run)
    }
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-origin-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const runtime = await createPeerRuntime({
    workspace: { projects: [project('p_one', repo.repoPath)], worktrees: [], terminals: [] },
    dial: () => {
      throw new Error('this test never reaches a relay')
    },
    scheduler: createManualScheduler(),
    runner: counting,
    dataDir,
    env: {}
  })
  await runtime.service.start()

  const afterStart = originReads
  for (let call = 0; call < 5; call += 1) await status(runtime)
  // A window refreshing costs a `stat`, never a subprocess.
  expect(originReads).toBe(afterStart)
})
