// Consent is permission to run. It is not a promise that running is still
// allowed, and it is not a promise that running is still possible.
//
// A held keystroke is the one place in this design where a decision and the act
// it authorises are separated by a person's attention span — up to
// `CONSENT_WINDOW_MS` of it. Everything the verdict rests on can move inside
// that window: the pane can exit, the pane can be closed, the roster can drop
// the sender, the owner can mute. So `PeerService.#settle` does not hand an
// allowed keystroke to the dispatcher; it hands it back through the *whole* of
// `#judge` with one step skipped — the asking — and every other check runs
// again at the moment the bytes would reach the pty rather than at the moment
// they arrived.
//
// That re-judgment had no test. It is the difference between a prompt and a
// signed blank cheque, and "the code currently does it" is exactly the state
// PR #58 and PR #59 found things in.
//
// The rest of this file is the other half of the same promise, from
// `docs/teamwork.md`: *the person who typed always learns what became of it —
// allowed, refused, expired, or the link went.* Three of those four had tests.
// The two that did not are here: a runtime that stops with questions on screen,
// and the deadline ordering that decides which sentence the person who typed is
// given when nobody answers at all.
//
// Nothing here is an exploit. It is the record of what was probed and held.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSENT_WINDOW_MS } from '../../src/shared/entities'
import { ErrorCode } from '../../src/shared/protocol'
import { PEER_CALL_TIMEOUT_MS, PEER_WRITE_TIMEOUT_MS } from '../../src/main/runtime/peerTransport'
import { loadIdentity } from '../../src/main/teamwork/identity'
import { MEMBERS_DIR_SEGMENTS, MEMBER_FILE_SUFFIX } from '../../src/main/teamwork/memberFile'
import { linkIdFor } from '../../src/main/teamwork/peer/peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  heldBy,
  makeProjectDir,
  project,
  remoteRunner,
  terminal,
  worktree,
  type PeerRuntime
} from '../../src/main/teamwork/peer/peerTestSupport'
import { normaliseRemote, projectKeyFor } from '../../src/main/teamwork/peer/projectKey'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@example.invalid:team/repo.git'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * The owner, one running pane, and Mallory on the roster with no permission.
 *
 * No standing grant anywhere: every test below starts from "nobody may type
 * here until I say", drives one keystroke into the question it becomes, and
 * then changes the world under the answer.
 */
async function owner() {
  const mallorydata = await mkdtemp(join(tmpdir(), 'teamree-sec-mallory-'))
  const mallory = (await loadIdentity(mallorydata)).publicKey
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-sec-consent-'))
  const ownerKey = (await loadIdentity(dataDir)).publicKey
  const dir = await makeProjectDir([
    { handle: 'owner', publicKey: ownerKey },
    { handle: 'mallory', publicKey: mallory }
  ])

  const scheduler = createManualScheduler()
  const runtime = await createPeerRuntime({
    dial: createFakeRelay().dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    dataDir,
    runner: remoteRunner({ [dir]: ORIGIN }),
    workspace: {
      projects: [project('p_a', dir)],
      worktrees: [worktree('wt_a', 'p_a', 'a', 'main')],
      terminals: [terminal('t_a1', 'wt_a', { running: true })]
    }
  })
  await runtime.service.start()
  await scheduler.advance(0)
  cleanups.push(() => runtime.service.stop())
  return { runtime, scheduler, dir, linkId: linkIdFor(mallory, PROJECT_KEY) }
}

const questions = (runtime: PeerRuntime) => runtime.service.requests({ projectId: 'p_a' }).requests
const outcomes = async (runtime: PeerRuntime): Promise<string[]> =>
  (await runtime.service.writeLog({})).writes.map((entry) => entry.outcome)

describe('what the owner’s yes is, and what it is not', () => {
  it('does not run in a pane whose process exited while the question was on screen', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'deploy\r', bytes: 7 }))
    const [question] = questions(runtime)

    // The agent in that pane finished while the owner was reading the prompt.
    // Their "yes" was about a live shell; there is no longer one.
    const pane = runtime.workspace.terminals.find((entry) => entry.id === 't_a1')
    if (pane) pane.running = false

    runtime.service.decide({ requestId: question?.id ?? '', decision: 'once' })

    // `not_found` rather than `conflict`: the re-judgment is the ordinary
    // refusal path, so the answer is the same one an unheld keystroke at a
    // dead pane gets. Being allowed does not put a teammate on a different
    // branch of the judgment, and it does not give them a different answer.
    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'that pane’s process has exited'
    })
    // And the record says what happened rather than what was authorised. An
    // audit trail that filed this as `written` would be the worse of the two
    // failures: an invented entry, which is believed.
    expect(await outcomes(runtime)).toEqual(['no-pane'])
  })

  it('does not run in a pane that is no longer there at all', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 }))
    const [question] = questions(runtime)

    runtime.workspace.terminals = runtime.workspace.terminals.filter((entry) => entry.id !== 't_a1')

    runtime.service.decide({ requestId: question?.id ?? '', decision: 'always' })

    // "Always allow this teammate in this pane" is answered by there being no
    // pane, which is the same sentence anybody naming a pane that is not there
    // gets — the permission is not a way to find out that it went, either.
    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no such pane in this project'
    })
    expect(await outcomes(runtime)).toEqual(['no-pane'])
  })

  it('does not run for a teammate the roster dropped, and never leaves the question up', async () => {
    const { runtime, dir, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 }))
    expect(questions(runtime)).toHaveLength(1)

    // The revocation, arriving as a `git pull` of the removal does: the key
    // leaves `.teamree/members` and this machine re-reads.
    await rm(join(dir, ...MEMBERS_DIR_SEGMENTS, `mallory${MEMBER_FILE_SUFFIX}`))
    await runtime.service.reconcile()

    // Answered by the revocation itself rather than left for the owner to
    // answer: a question on screen naming somebody who is no longer on the
    // project is a question whose every answer is already decided, and one the
    // owner could allow by reflex.
    expect(await held).toMatchObject({
      ok: false,
      code: ErrorCode.Conflict,
      message: 'this teammate is no longer on the project’s roster'
    })
    expect(questions(runtime)).toEqual([])
    expect(await outcomes(runtime)).toEqual(['expired'])
  })
})

describe('a keystroke nobody will ever answer', () => {
  it('is settled when the runtime stops, rather than left as a promise nothing ends', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 }))

    // The owner quit the app with the question still up. Nothing after this
    // point can answer it, and the person who typed is owed an end whatever the
    // end is — a promise that simply stops is the one outcome this whole path
    // exists to make impossible.
    runtime.service.stop()

    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.Conflict,
      message: 'this runtime stopped while the owner was being asked'
    })
    expect(await outcomes(runtime)).toEqual(['expired'])
  })

  it('leaves the machine doing the typing more patient than the machine doing the deciding', () => {
    // The one ordering in this feature that must never break. A held keystroke
    // waits on a person for a whole `CONSENT_WINDOW_MS`; the caller's own
    // deadline has to outlast that, or a teammate would be told their colleague
    // never answered at the exact moment their colleague was answering, and the
    // owner's "yes" would land on a request already given up on. `expired`,
    // `denied` and `allowed` are three different sentences and only this
    // inequality decides that the person who typed gets the right one.
    expect(PEER_WRITE_TIMEOUT_MS).toBeGreaterThan(CONSENT_WINDOW_MS)
    // Derived rather than chosen beside it: the window plus the ordinary
    // allowance for the round trip, so raising the window cannot silently
    // overtake the deadline.
    expect(PEER_WRITE_TIMEOUT_MS).toBe(CONSENT_WINDOW_MS + PEER_CALL_TIMEOUT_MS)
  })
})
