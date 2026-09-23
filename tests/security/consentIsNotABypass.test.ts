// Consent is permission to run, not a promise that running is still allowed or possible: up to
// `CONSENT_WINDOW_MS` passes between decision and act, so `PeerService.#settle` sends an allowed
// keystroke back through the whole of `#judge` minus the asking. Also: a runtime that stops with
// questions up, and the deadline ordering that picks which sentence the typist gets when nobody answers.

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

/** The owner, one running pane, and Mallory on the roster with no standing grant. */
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

    // The agent finished while the owner was reading the prompt; the "yes" was about a live shell.
    const pane = runtime.workspace.terminals.find((entry) => entry.id === 't_a1')
    if (pane) pane.running = false

    runtime.service.decide({ requestId: question?.id ?? '', decision: 'once' })

    // `not_found` rather than `conflict`: the re-judgment is the ordinary refusal path, so the
    // answer is the one an unheld keystroke at a dead pane gets.
    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'that pane’s process has exited'
    })
    // The record says what happened, not what was authorised: `written` here would be an invented entry.
    expect(await outcomes(runtime)).toEqual(['no-pane'])
  })

  it('does not run in a pane that is no longer there at all', async () => {
    const { runtime, linkId } = await owner()
    const held = heldBy(runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 }))
    const [question] = questions(runtime)

    runtime.workspace.terminals = runtime.workspace.terminals.filter((entry) => entry.id !== 't_a1')

    runtime.service.decide({ requestId: question?.id ?? '', decision: 'always' })

    // The same sentence anybody naming an absent pane gets: permission is not a way to learn it went.
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

    // The revocation as a `git pull` delivers it: the key leaves `.teamree/members`, this machine re-reads.
    await rm(join(dir, ...MEMBERS_DIR_SEGMENTS, `mallory${MEMBER_FILE_SUFFIX}`))
    await runtime.service.reconcile()

    // Answered by the revocation itself: a question naming somebody no longer on the project is one
    // the owner could allow by reflex.
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

    // The owner quit with the question up; the typist is owed an end, whatever it is.
    runtime.service.stop()

    expect(await held).toEqual({
      ok: false,
      code: ErrorCode.Conflict,
      message: 'this runtime stopped while the owner was being asked'
    })
    expect(await outcomes(runtime)).toEqual(['expired'])
  })

  it('leaves the machine doing the typing more patient than the machine doing the deciding', () => {
    // The caller's deadline must outlast the whole `CONSENT_WINDOW_MS`, or the typist is told nobody
    // answered at the moment the owner is answering, and the "yes" lands on a request given up on.
    expect(PEER_WRITE_TIMEOUT_MS).toBeGreaterThan(CONSENT_WINDOW_MS)
    // Derived, so raising the window cannot silently overtake the deadline.
    expect(PEER_WRITE_TIMEOUT_MS).toBe(CONSENT_WINDOW_MS + PEER_CALL_TIMEOUT_MS)
  })
})
