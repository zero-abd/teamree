// FIXED: nothing bounded how often a teammate could type, and every keystroke
// cost the main process a workspace rescan and a window refresh. These tests
// are the attack, and they now assert that it fails.
//
// `terminal.write` is the one method on `PEER_METHODS` that runs code, and the
// only per-request limit on it used to be `MAX_REMOTE_WRITE_BYTES` on `data`.
// There was no token bucket, no per-link counter and no per-second ceiling
// anywhere between the Noise session and the pty.
//
// Two costs the owner pays per request, both on the Electron main thread —
// which owns every PTY and the window's IPC:
//
//   * `PeerService.#paneOf` walks every worktree of the project and lists the
//     terminals of each, per write.
//   * `PeerService.#tellWindowAboutTyping` throttles to `TYPING_PULSE_MS`, but
//     only for a write that is *not* `fresh`, and `fresh` used to be computed
//     per (terminalId, publicKey). A caller that named a new `terminalId` each
//     time was fresh every time, so the throttle never applied and `onChange`
//     fired once per request. `onChange` is what makes the window refetch.
//
// Both are closed. `peerTransport.handleRequest` spends a per-link token bucket
// before anything else happens — a tighter one again for `terminal.write` — so
// one relay frame is no longer as many dispatches as fit in it. And freshness
// is now a fact about the *person*, taken from their handshake key, rather than
// about the pane id they named: a burst is one burst however many made-up panes
// it mentions. A write that names no pane of this machine is not attributed at
// all, because nothing reads that map under an id this machine does not have.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../../src/main/teamwork/identity'
import { linkIdFor, UNAIMED_LOGGED_PER_BURST } from '../../src/main/teamwork/peer/peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  terminal,
  worktree,
  type PeerRuntime
} from '../../src/main/teamwork/peer/peerTestSupport'
import { normaliseRemote, projectKeyFor } from '../../src/main/teamwork/peer/projectKey'
import { PEER_REQUEST_BURST, PEER_WRITE_BURST } from '../../src/main/runtime/peerTransport'
import { ErrorCode } from '../../src/shared/protocol'
import { generateStaticKeyPair } from '../../src/shared/peer'
import { ownerRig, refusalsOf, settle } from './peerRig'

const ORIGIN = 'git@example.invalid:team/repo.git'
const RELAY_URL = 'ws://relay.invalid/v1/relay'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)

async function victim(): Promise<{ alice: PeerRuntime; linkId: string }> {
  const scheduler = createManualScheduler()
  const relay = createFakeRelay()
  const mallory = Buffer.from(generateStaticKeyPair().publicKey).toString('base64')
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-sec-rate-'))
  const { publicKey: aliceKey } = await loadIdentity(dataDir)
  const projectPath = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'mallory', publicKey: mallory }
  ])

  const alice = await createPeerRuntime({
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN),
    dataDir,
    workspace: {
      projects: [project('p_alice', projectPath)],
      worktrees: [worktree('wt_a1', 'p_alice', 'search ranking', 'feat/ranking')],
      terminals: [terminal('t_a1', 'wt_a1', { running: true })]
    }
  })
  await alice.service.start()
  return { alice, linkId: linkIdFor(mallory, PROJECT_KEY) }
}

/** One `terminal.write` line, framed the way the attacker's own client would. */
const writeLine = (n: number, terminalId: string): string =>
  JSON.stringify({ id: `w${n}`, method: 'terminal.write', params: { terminalId, data: 'x' } })

describe('what one teammate’s typing costs the owner’s main thread', () => {
  it('control: repeated writes to one pane are throttled to a pulse', async () => {
    const { alice, linkId } = await victim()
    const before = alice.changes()

    for (let n = 0; n < 400; n += 1) {
      alice.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'x', bytes: 1 })
    }

    // One burst, announced once: this is the throttle working as written.
    expect(alice.changes() - before).toBe(1)
  })

  it('ATTACK: a new terminalId per write no longer defeats the throttle', async () => {
    const { alice, linkId } = await victim()
    const before = alice.changes()

    // Every one of these is refused — there is no such pane — and every one of
    // them used to be `fresh`, so every one of them woke the window. Freshness
    // is per person now, and a pane this machine does not have is not something
    // the window has anything to show about.
    for (let n = 0; n < 400; n += 1) {
      alice.service.remoteWrite(linkId, { terminalId: `ghost_${n}`, data: 'x', bytes: 1 })
    }

    expect(alice.changes() - before).toBe(0)

    // And every one of the refusals is still accounted for, which is the half
    // of this that must not be traded away for the quiet. Not a line each: a
    // line each is how a flood rolls the owner's real entries off the end of a
    // log that rotates at a size, so the first of a burst are filed as they are
    // and the rest are counted into one entry. Filed plus counted is all 400.
    const log = await alice.service.writeLog({})
    const refusals = log.writes.filter((write) => write.outcome === 'no-pane')
    expect(refusals).toHaveLength(UNAIMED_LOGGED_PER_BURST + 1)
    expect(refusals.at(-1)?.reason).toBe(
      `${400 - UNAIMED_LOGGED_PER_BURST} further keystrokes from this link reached no pane of this project ` +
        'and were counted rather than filed one by one'
    )
  })

  it('ATTACK: varying the pane id does not buy a window refresh per keystroke either', async () => {
    const { alice, linkId } = await victim()
    const before = alice.changes()

    // The same burst against the pane that does exist, alternating with panes
    // that do not: the real writes land, and the burst is still one burst.
    for (let n = 0; n < 400; n += 1) {
      alice.service.remoteWrite(linkId, { terminalId: n % 2 === 0 ? 't_a1' : `ghost_${n}`, data: 'x', bytes: 1 })
    }

    expect(alice.changes() - before).toBe(1)
  })

  it('ATTACK: a teammate is refused for typing too fast', async () => {
    const owner = ownerRig()

    // Ten thousand keystrokes into a real, running pane, back to back — the
    // same flood, now against a transport that has a budget.
    const lines: string[] = []
    for (let n = 0; n < 10_000; n += 1) lines.push(writeLine(n, 't_1'))
    for (let at = 0; at < lines.length; at += 500) owner.sendRaw(lines.slice(at, at + 500))
    await settle()

    // Nothing past the bucket reached the owner's verdict, the owner's log or
    // the pane, and the walk of every worktree that a verdict costs happened
    // once per accepted keystroke rather than ten thousand times. The bound is
    // the burst plus whatever the bucket earned back while the flood was being
    // decrypted — real milliseconds, so it is asserted with room rather than to
    // the token.
    const ceiling = PEER_WRITE_BURST * 2
    expect(owner.judged().length).toBeLessThanOrEqual(ceiling)
    expect(owner.written().length).toBeLessThanOrEqual(ceiling)
    expect(owner.dispatched()).toBeLessThanOrEqual(ceiling)
    expect(owner.written().length).toBeGreaterThan(0)
    // Refused rather than dropped: somebody who typed is told their keystrokes
    // went nowhere, which is the rule every other refusal here follows.
    const refusals = refusalsOf(owner.replies())
    expect(refusals.length).toBe(10_000 - owner.written().length)
    expect(refusals.every((refusal) => refusal.code === ErrorCode.Conflict)).toBe(true)
    expect(refusals[refusals.length - 1]?.message).toMatch(/slow down/)
  })

  it('leaves an ordinary hand alone: a fast typist and a paste are not a flood', async () => {
    const owner = ownerRig()

    // Forty keystrokes in one breath is a held-down key for a second or a burst
    // of typing; a person cannot do more, and nothing here may refuse it.
    const lines: string[] = []
    for (let n = 0; n < 40; n += 1) lines.push(writeLine(n, 't_1'))
    owner.sendRaw(lines)
    await settle()

    expect(owner.written()).toHaveLength(40)
    expect(refusalsOf(owner.replies())).toHaveLength(0)
  })

  it('bounds a frame of anything at all, not only of keystrokes', async () => {
    const owner = ownerRig()

    // One Noise transport message carries 65,455 bytes of newline-delimited
    // JSON, which is hundreds of requests — so the relay's frame budget was
    // never a bound on how much work one second of wire could buy.
    const lines: string[] = []
    for (let n = 0; n < 2_000; n += 1) {
      lines.push(JSON.stringify({ id: `r${n}`, method: 'unsubscribe', params: { subscription: `sub_${n}` } }))
    }
    for (let at = 0; at < lines.length; at += 500) owner.sendRaw(lines.slice(at, at + 500))
    await settle()

    // Again the burst plus what time gave back, rather than the burst exactly.
    expect(owner.dispatched()).toBeLessThanOrEqual(PEER_REQUEST_BURST * 2)
    expect(refusalsOf(owner.replies()).length).toBe(2_000 - owner.dispatched())
  })
})
