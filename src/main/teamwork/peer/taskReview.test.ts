// Reviewing a teammate's task: the inbox's bounds and file, and two runtimes over a relay proving Alice
// reads Bob's task (his pushed branch, else a patch his machine sends) and her comments land on his task.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../../shared/protocol'
import { MAX_PEER_PATCH_BYTES, type ReceivedReview, type ReviewNote } from '../../../shared/teammateReview'
import { createGitRunner, type GitRunner } from '../../git/gitProcess'
import { createTempRepo } from '../../git/testRepository'
import { loadIdentity } from '../identity'
import { formatMemberFile, MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS } from '../memberFile'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  presenceOf,
  project,
  worktree,
  type PeerRuntimeOptions
} from './peerTestSupport'
import { parsePeerPresence } from './peerService'
import { MAX_HELD_REVIEWS, MAX_UNSEEN_REVIEWS_PER_SENDER, ReviewInbox, type ArrivingReview } from './taskReview'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@example.invalid:team/repo.git'
const BOB_PATCH = 'diff --git a/footer.txt b/footer.txt\n--- a/footer.txt\n+++ b/footer.txt\n@@ -1 +1 @@\n-old\n+new\n'
const COMMENT: ReviewNote = {
  path: 'footer.txt',
  lines: [{ kind: 'added', text: 'new', oldNumber: null, newNumber: 1 }],
  note: 'Say the brand name'
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

const arriving = (publicKey: string, over: Partial<ArrivingReview> = {}): ArrivingReview => ({
  projectId: 'p',
  worktreeId: 'w',
  handle: publicKey,
  publicKey,
  comments: [COMMENT],
  sentAt: 1,
  ...over
})

describe('the review inbox', () => {
  it('refuses a sender with too many unseen reviews, and nobody else', () => {
    const inbox = new ReviewInbox({ now: () => 0 })
    for (let index = 0; index < MAX_UNSEEN_REVIEWS_PER_SENDER; index += 1) inbox.add(arriving('ana'))
    expect(() => inbox.add(arriving('ana'))).toThrow(/unread/)
    expect(() => inbox.add(arriving('bo'))).not.toThrow()
  })

  it('makes room by forgetting the oldest seen review, never an unseen one', () => {
    const inbox = new ReviewInbox({ now: () => 0 })
    const held = Array.from({ length: MAX_HELD_REVIEWS }, (_, index) => inbox.add(arriving(`key${index}`)))
    expect(() => inbox.add(arriving('late'))).toThrow(/too many unread/)
    inbox.settle(held[3]?.id ?? '', 'seen')
    inbox.add(arriving('late'))
    expect(inbox.list('p').map((review) => review.publicKey)).not.toContain('key3')
  })

  it('keeps what it was told across a restart', async () => {
    const path = join(await scratch('teamree-reviews-'), 'reviews.json')
    const first = new ReviewInbox({ path, now: () => 5 })
    const filed = first.add(arriving('ana'))
    first.settle(filed.id, 'seen')
    await first.flush()

    const again = new ReviewInbox({ path, now: () => 9 })
    await again.load()
    expect(again.list()).toEqual([{ ...filed, seen: true }])
    expect(again.settle(filed.id, 'closed')).toBe(true)
    expect(again.list()).toEqual([])
  })
})

/** Alice and Bob on one relay, both on each other's roster. Bob has the task `fix footer` on `fix-footer`. */
async function pair(
  options: {
    runner?: GitRunner
    alicePath?: string
    bobPath?: string
    bob?: Partial<PeerRuntimeOptions>
  } = {}
) {
  const relay = createFakeRelay()
  const scheduler = createManualScheduler()
  const aliceData = await scratch('teamree-alice-')
  const bobData = await scratch('teamree-bob-')
  const roster = [
    { handle: 'alice', publicKey: (await loadIdentity(aliceData)).publicKey },
    { handle: 'bob', publicKey: (await loadIdentity(bobData)).publicKey }
  ]
  const shared = {
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: options.runner ?? fixedRemoteRunner(ORIGIN)
  }
  const inProject = async (path: string | undefined): Promise<string> =>
    path === undefined ? makeProjectDir(roster) : withRoster(path, roster)
  const alice = await createPeerRuntime({
    ...shared,
    dataDir: aliceData,
    workspace: {
      projects: [project('p_alice', await inProject(options.alicePath))],
      worktrees: [worktree('wt_a', 'p_alice', 'a', 'main')],
      terminals: []
    }
  })
  const reviewed: ReceivedReview[] = []
  const bob = await createPeerRuntime({
    ...shared,
    dataDir: bobData,
    workspace: {
      projects: [project('p_bob', await inProject(options.bobPath))],
      worktrees: [worktree('wt_fix', 'p_bob', 'fix footer', 'fix-footer')],
      terminals: []
    },
    readTaskPatch: () => Promise.resolve({ patch: BOB_PATCH, truncated: false }),
    onReview: (review) => reviewed.push(review),
    ...options.bob
  })
  await alice.service.start()
  cleanups.push(() => alice.service.stop())
  await bob.service.start()
  cleanups.push(() => bob.service.stop())
  await scheduler.advance(0)
  const bobsTask = presenceOf(alice.service, 'p_alice').worktrees.find((row) => row.name === 'fix footer')
  if (bobsTask === undefined) throw new Error('alice never saw bob’s task')
  return { alice, bob, scheduler, reviewed, taskId: bobsTask.id }
}

async function withRoster(path: string, roster: readonly { handle: string; publicKey: string }[]): Promise<string> {
  await mkdir(join(path, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
  for (const member of roster) {
    await writeFile(
      join(path, ...MEMBERS_DIR_SEGMENTS, `${member.handle}${MEMBER_FILE_SUFFIX}`),
      formatMemberFile({ ...member, addedAt: '2026-01-01' }),
      'utf8'
    )
  }
  return path
}

describe('a teammate’s task over a relay', () => {
  it('comes from their machine when it was never pushed', async () => {
    const { alice, scheduler, taskId } = await pair()
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    await scheduler.advance(0)

    expect(await reading).toMatchObject({
      worktreeId: taskId,
      handle: 'bob',
      branch: 'fix-footer',
      source: 'peer',
      patch: BOB_PATCH,
      truncated: false
    })
  })

  it('is refused while its owner is not sharing task details', async () => {
    const { alice, scheduler, taskId } = await pair({ bob: { shareTaskDetails: () => false } })
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    await scheduler.advance(0)
    await expect(reading).rejects.toThrow('the owner is not sharing task details')
  })

  it('is cut at the cap, and says so', async () => {
    const huge = `${BOB_PATCH}${'+x\n'.repeat(MAX_PEER_PATCH_BYTES)}`
    const { alice, scheduler, taskId } = await pair({
      bob: { readTaskPatch: () => Promise.resolve({ patch: huge, truncated: false }) }
    })
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    await scheduler.advance(0)
    const diff = await reading
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(MAX_PEER_PATCH_BYTES)
    expect(diff.patch.startsWith(BOB_PATCH)).toBe(true)
  })

  it('says a teammate’s older build cannot send it, rather than failing blankly', async () => {
    const { alice, scheduler, taskId } = await pair({ bob: { olderThan: ['peer.taskPatch', 'peer.review'] } })
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    const sending = alice.service.sendReview({ projectId: 'p_alice', worktreeId: taskId, comments: [COMMENT] })
    await scheduler.advance(0)
    await expect(reading).rejects.toThrow('bob’s teamree is too old to send its diff')
    await expect(sending).rejects.toThrow('bob’s teamree is too old to take a review')
  })

  it('is refused for a task the teammate does not have', async () => {
    const { alice, scheduler } = await pair()
    const reading = alice.dispatch(
      { id: 'd', method: 'teamwork.teammateDiff', params: { projectId: 'p_alice', worktreeId: 'peer:nobody:wt_x' } },
      { connectionId: 'window' }
    )
    await scheduler.advance(0)
    expect(await reading).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
  })
})

describe('comments on a teammate’s task', () => {
  it('land on the owner’s task, named by their roster, and outlive a restart', async () => {
    const { alice, bob, scheduler, reviewed, taskId } = await pair()
    const changes = bob.changes()
    const sending = alice.service.sendReview({ projectId: 'p_alice', worktreeId: taskId, comments: [COMMENT] })
    await scheduler.advance(0)
    expect(await sending).toEqual({ delivered: true })

    expect(bob.service.reviews({ projectId: 'p_bob' })).toMatchObject([
      { projectId: 'p_bob', worktreeId: 'wt_fix', handle: 'alice', comments: [COMMENT], seen: false }
    ])
    expect(reviewed.map((review) => review.handle)).toEqual(['alice'])
    expect(bob.changes()).toBeGreaterThan(changes)
    expect(alice.service.reviews({})).toEqual([])

    const [filed] = bob.service.reviews({})
    expect(bob.service.settleReview({ id: filed?.id ?? '', how: 'seen' })).toEqual({ settled: true })
    await bob.service.flushReviews()
    const again = new ReviewInbox({ path: join(bob.dataDir, 'reviews.json'), now: () => 0 })
    await again.load()
    expect(again.list()).toMatchObject([{ id: filed?.id, seen: true }])
  })

  it('naming a task the owner does not have are refused and nothing is filed', async () => {
    const { alice, bob, scheduler, taskId } = await pair()
    const sending = alice.service.sendReview({
      projectId: 'p_alice',
      worktreeId: taskId.replace('wt_fix', 'wt_gone'),
      comments: [COMMENT]
    })
    await scheduler.advance(0)
    await expect(sending).rejects.toThrow()
    expect(bob.service.reviews({})).toEqual([])
  })

  it('are refused while the owner is offline', async () => {
    const { alice, bob, scheduler, taskId } = await pair()
    await bob.service.stop()
    await scheduler.advance(0)
    const sending = alice.service.sendReview({ projectId: 'p_alice', worktreeId: taskId, comments: [COMMENT] })
    await scheduler.advance(0)
    await expect(sending).rejects.toThrow('bob is offline')
  })
})

describe('a pushed branch', () => {
  /** Bob's checkout and origin, `fix-footer` pushed with one commit; Alice's clone of the same origin. */
  async function pushed() {
    const repo = await createTempRepo({ withRemote: true })
    cleanups.push(() => repo.cleanup())
    await repo.git(['checkout', '-b', 'fix-footer'])
    await repo.write('footer.txt', 'new\n')
    await repo.commit('Footer says new')
    await repo.git(['push', '-u', 'origin', 'fix-footer'])
    await repo.git(['checkout', 'main'])
    const alicePath = join(repo.base, 'alice')
    await repo.git(['clone', join(repo.base, 'origin.git'), alicePath], repo.base)
    return { repo, alicePath }
  }

  it('is read from origin when it has every commit the owner reports', async () => {
    const { repo, alicePath } = await pushed()
    const { alice, scheduler, taskId } = await pair({
      runner: createGitRunner(),
      alicePath,
      bobPath: repo.repoPath,
      bob: {
        readTaskGit: () => Promise.resolve({ paths: ['footer.txt'], ahead: 1, clean: true }),
        readTaskPatch: () => Promise.reject(new Error('the peer was asked'))
      }
    })
    await scheduler.advance(2_000)
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    await scheduler.advance(0)
    const diff = await readingSettled(reading, scheduler)
    expect(diff).toMatchObject({ source: 'origin', branch: 'fix-footer', truncated: false })
    expect(diff.patch).toContain('+new')
  })

  it('is passed over for the owner’s machine when they have work it does not carry', async () => {
    const { repo, alicePath } = await pushed()
    const { alice, scheduler, taskId } = await pair({
      runner: createGitRunner(),
      alicePath,
      bobPath: repo.repoPath,
      bob: { readTaskGit: () => Promise.resolve({ paths: ['footer.txt'], ahead: 1, clean: false }) }
    })
    await scheduler.advance(2_000)
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    expect(await readingSettled(reading, scheduler)).toMatchObject({ source: 'peer', patch: BOB_PATCH })
  })

  it('is passed over for the owner’s machine when they have committed past it', async () => {
    const { repo, alicePath } = await pushed()
    const { alice, scheduler, taskId } = await pair({
      runner: createGitRunner(),
      alicePath,
      bobPath: repo.repoPath,
      bob: { readTaskGit: () => Promise.resolve({ paths: ['footer.txt'], ahead: 2, clean: true }) }
    })
    await scheduler.advance(2_000)
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    expect(await readingSettled(reading, scheduler)).toMatchObject({ source: 'peer', patch: BOB_PATCH })
  })
})

/** Real git runs on real time while the relay runs on the manual clock, so both are turned until it settles. */
async function readingSettled<T>(
  reading: Promise<T>,
  scheduler: { advance: (ms: number) => Promise<void> }
): Promise<T> {
  let settled = false
  void reading.then(
    () => (settled = true),
    () => (settled = true)
  )
  for (let turn = 0; turn < 200 && !settled; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    await scheduler.advance(0)
  }
  return reading
}

describe('asking a teammate for a review', () => {
  it('reaches them in presence as their own task id, and is done once they send one', async () => {
    const { alice, bob, scheduler, taskId } = await pair()
    const asked = bob.service.requestReview({ worktreeId: 'wt_fix', to: 'alice' })
    await scheduler.advance(1_000)

    expect(asked).toMatchObject({ to: 'alice', from: 'bob', worktreeId: 'wt_fix', worktreeName: 'fix footer' })
    expect(bob.service.reviewRequests({ projectId: 'p_bob' }).outgoing).toMatchObject([{ id: asked.id }])
    expect(alice.service.reviewRequests({ projectId: 'p_alice' })).toEqual({
      incoming: [{ ...asked, worktreeId: taskId, from: 'bob' }],
      outgoing: []
    })

    const sending = alice.service.sendReview({ projectId: 'p_alice', worktreeId: taskId, comments: [COMMENT] })
    await scheduler.advance(1_000)
    await sending
    expect(bob.service.reviewRequests({ projectId: 'p_bob' }).outgoing).toEqual([])
    expect(alice.service.reviewRequests({ projectId: 'p_alice' }).incoming).toEqual([])
  })

  it('is the owner’s consent to the diff even with task details unshared', async () => {
    const { alice, bob, scheduler, taskId } = await pair({ bob: { shareTaskDetails: () => false } })
    bob.service.requestReview({ worktreeId: 'wt_fix', to: 'alice' })
    await scheduler.advance(1_000)
    const reading = alice.service.teammateDiff({ projectId: 'p_alice', worktreeId: taskId })
    await scheduler.advance(0)
    expect(await reading).toMatchObject({ source: 'peer', patch: BOB_PATCH })
  })

  it('retires its popup when seen, leaves the list on Later, and remembers both', async () => {
    const { alice, bob, scheduler } = await pair()
    const asked = bob.service.requestReview({ worktreeId: 'wt_fix', to: 'alice' })
    await scheduler.advance(1_000)

    expect(alice.service.settleReviewRequest({ projectId: 'p_alice', id: asked.id, how: 'seen' })).toEqual({
      settled: true
    })
    expect(alice.service.reviewRequests({ projectId: 'p_alice' }).incoming).toMatchObject([{ seen: true }])
    alice.service.settleReviewRequest({ projectId: 'p_alice', id: asked.id, how: 'later' })
    expect(alice.service.reviewRequests({ projectId: 'p_alice' }).incoming).toEqual([])
    await alice.service.flushReviews()
    const again = new ReviewInbox({ path: join(alice.dataDir, 'reviews.json'), now: () => 0 })
    await again.load()
    expect(again.answerOf(asked.id, (await loadIdentity(bob.dataDir)).publicKey)).toBe('later')
  })

  it('moves out of the waiting list once opened, and stays opened after a restart', async () => {
    const { alice, bob, scheduler } = await pair()
    const asked = bob.service.requestReview({ worktreeId: 'wt_fix', to: 'alice' })
    await scheduler.advance(1_000)

    alice.service.settleReviewRequest({ projectId: 'p_alice', id: asked.id, how: 'opened' })
    expect(alice.service.reviewRequests({ projectId: 'p_alice' }).incoming).toMatchObject([
      { id: asked.id, seen: true, opened: true }
    ])
    await alice.service.flushReviews()
    const again = new ReviewInbox({ path: join(alice.dataDir, 'reviews.json'), now: () => 0 })
    await again.load()
    expect(again.answerOf(asked.id, (await loadIdentity(bob.dataDir)).publicKey)).toBe('opened')
  })

  it('is refused for anyone not on the roster, and for a task that is not here', async () => {
    const { bob } = await pair()
    expect(() => bob.service.requestReview({ worktreeId: 'wt_fix', to: 'mallory' })).toThrow(/not on this project/)
    expect(() => bob.service.requestReview({ worktreeId: 'wt_gone', to: 'alice' })).toThrow(/no worktree/)
  })

  it('is dropped alone when malformed, never the snapshot', () => {
    const snapshot = {
      revision: 1,
      handle: 'bob',
      projects: [{ projectKey: 'k', worktrees: [] }],
      reviewRequests: [{ id: 'r1', to: '' }]
    }
    const read = parsePeerPresence(snapshot, 'k')
    expect(read?.projects).toHaveLength(1)
    expect(read).not.toHaveProperty('reviewRequests')
  })
})
