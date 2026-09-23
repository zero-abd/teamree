// The flood attack on `terminal.write`, asserted to fail. Each write cost the main thread a worktree walk
// (`#paneOf`) and, with a fresh made-up `terminalId`, an unthrottled window refresh. Now
// `peerTransport.handleRequest` spends a per-link token bucket first (tighter for writes), and
// freshness is per handshake key, not per pane id.

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

    // All refused (no such pane), and freshness is per person, so they no longer wake the window.
    for (let n = 0; n < 400; n += 1) {
      alice.service.remoteWrite(linkId, { terminalId: `ghost_${n}`, data: 'x', bytes: 1 })
    }

    expect(alice.changes() - before).toBe(0)

    // Still accounted for: the first of a burst are filed and the rest counted into one entry, so a flood
    // cannot rotate real entries out of the log. Filed plus counted is all 400.
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

    // Real writes alternating with fake panes: the real ones land, still one burst.
    for (let n = 0; n < 400; n += 1) {
      alice.service.remoteWrite(linkId, { terminalId: n % 2 === 0 ? 't_a1' : `ghost_${n}`, data: 'x', bytes: 1 })
    }

    expect(alice.changes() - before).toBe(1)
  })

  it('ATTACK: a teammate is refused for typing too fast', async () => {
    const owner = ownerRig()

    // Ten thousand keystrokes into a real pane, against a transport with a budget.
    const lines: string[] = []
    for (let n = 0; n < 10_000; n += 1) lines.push(writeLine(n, 't_1'))
    for (let at = 0; at < lines.length; at += 500) owner.sendRaw(lines.slice(at, at + 500))
    await settle()

    // Nothing past the bucket reached verdict, log or pane; bounded by the burst plus what the bucket
    // refilled during decryption, so asserted with room.
    const ceiling = PEER_WRITE_BURST * 2
    expect(owner.judged().length).toBeLessThanOrEqual(ceiling)
    expect(owner.written().length).toBeLessThanOrEqual(ceiling)
    expect(owner.dispatched()).toBeLessThanOrEqual(ceiling)
    expect(owner.written().length).toBeGreaterThan(0)
    // Refused, not dropped: the typist is told.
    const refusals = refusalsOf(owner.replies())
    expect(refusals.length).toBe(10_000 - owner.written().length)
    expect(refusals.every((refusal) => refusal.code === ErrorCode.Conflict)).toBe(true)
    expect(refusals[refusals.length - 1]?.message).toMatch(/slow down/)
  })

  it('leaves an ordinary hand alone: a fast typist and a paste are not a flood', async () => {
    const owner = ownerRig()

    // Forty in one breath is a person typing; nothing may refuse it.
    const lines: string[] = []
    for (let n = 0; n < 40; n += 1) lines.push(writeLine(n, 't_1'))
    owner.sendRaw(lines)
    await settle()

    expect(owner.written()).toHaveLength(40)
    expect(refusalsOf(owner.replies())).toHaveLength(0)
  })

  it('bounds a frame of anything at all, not only of keystrokes', async () => {
    const owner = ownerRig()

    // One Noise message holds 65,455 bytes of NDJSON, hundreds of requests: the frame budget never bounded work.
    const lines: string[] = []
    for (let n = 0; n < 2_000; n += 1) {
      lines.push(JSON.stringify({ id: `r${n}`, method: 'unsubscribe', params: { subscription: `sub_${n}` } }))
    }
    for (let at = 0; at < lines.length; at += 500) owner.sendRaw(lines.slice(at, at + 500))
    await settle()

    expect(owner.dispatched()).toBeLessThanOrEqual(PEER_REQUEST_BURST * 2)
    expect(refusalsOf(owner.replies()).length).toBe(2_000 - owner.dispatched())
  })
})
