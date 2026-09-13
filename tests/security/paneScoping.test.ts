// Probes of the authorisation rules the peer surface actually enforces, at the
// two places a teammate's request is judged: `PeerService.remoteRead` and
// `PeerService.remoteWrite`.
//
// These are the checks `peerTransport.handleRequest` calls for `terminal.read`,
// `terminal.subscribe` and `terminal.write` respectively. Everything a teammate
// can reach that touches a pane goes through one of them, so this file is the
// authorisation surface.
//
// Nothing here is an exploit. It is the record of what was probed and held:
// cross-project reach in both directions, and revocation taking effect on the
// live session rather than at the next restart. If one of these ever goes red,
// a teammate on one repository's roster has reached a pane of a repository they
// hold no key for.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../../src/main/teamwork/identity'
import { MEMBERS_DIR_SEGMENTS, MEMBER_FILE_SUFFIX } from '../../src/main/teamwork/memberFile'
import { linkIdFor } from '../../src/main/teamwork/peer/peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  makeProjectDir,
  decided,
  project,
  remoteRunner,
  standingConsent,
  terminal,
  worktree
} from '../../src/main/teamwork/peer/peerTestSupport'
import { normaliseRemote, projectKeyFor } from '../../src/main/teamwork/peer/projectKey'
import { generateStaticKeyPair } from '../../src/shared/peer'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN_OPEN = 'git@example.invalid:team/open.git'
const ORIGIN_SECRET = 'git@example.invalid:team/secret.git'
const KEY_OPEN = projectKeyFor(normaliseRemote(ORIGIN_OPEN) as string)
const KEY_SECRET = projectKeyFor(normaliseRemote(ORIGIN_SECRET) as string)

/**
 * Alice, in two repositories. Mallory is on the roster of one of them.
 *
 * `p_open` is the repository they share. `p_secret` is one Mallory has no key
 * for, with a pane of its own, on the same machine and in the same runtime.
 */
async function twoProjects() {
  const scheduler = createManualScheduler()
  const relay = createFakeRelay()
  const mallory = Buffer.from(generateStaticKeyPair().publicKey).toString('base64')
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-sec-scope-'))
  const { publicKey: aliceKey } = await loadIdentity(dataDir)

  const openPath = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'mallory', publicKey: mallory }
  ])
  const secretPath = await makeProjectDir([{ handle: 'alice', publicKey: aliceKey }])

  const alice = await createPeerRuntime({
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: remoteRunner({ [openPath]: ORIGIN_OPEN, [secretPath]: ORIGIN_SECRET }),
    dataDir,
    // Alice settled the shared pane for Mallory before any of this: these are
    // probes of the scoping rules, and a keystroke held for a prompt would
    // prove nothing about which project it was scoped to. The private pane is
    // deliberately not settled — nothing could settle it, because Mallory is
    // not on that project at all, which is the whole point below.
    consent: standingConsent([{ terminalId: 't_open', publicKey: mallory }]),
    workspace: {
      projects: [project('p_open', openPath), project('p_secret', secretPath)],
      worktrees: [
        worktree('wt_open', 'p_open', 'shared', 'feat/shared'),
        worktree('wt_secret', 'p_secret', 'private', 'feat/private')
      ],
      terminals: [
        terminal('t_open', 'wt_open', { running: true }),
        terminal('t_secret', 'wt_secret', { running: true })
      ]
    }
  })
  await alice.service.start()

  return {
    alice,
    mallory,
    openPath,
    /** The connection id Mallory's session for the shared repository answers on. */
    shared: linkIdFor(mallory, KEY_OPEN),
    /** A session for the repository she has no key for, if she could ever get one. */
    forged: linkIdFor(mallory, KEY_SECRET)
  }
}

describe('what a teammate on one repository’s roster can reach', () => {
  it('reads and types into a pane of the repository they share', async () => {
    const { alice, shared } = await twoProjects()
    expect(alice.service.remoteRead(shared, 't_open').ok).toBe(true)
    expect(decided(alice.service.remoteWrite(shared, { terminalId: 't_open', data: 'x', bytes: 1 })).ok).toBe(true)
  })

  it('cannot read a pane of a repository it holds no key for', async () => {
    const { alice, shared } = await twoProjects()
    const verdict = alice.service.remoteRead(shared, 't_secret')
    expect(verdict.ok).toBe(false)
    // And is told nothing that distinguishes "in another project" from "does
    // not exist", so the refusal is not an oracle for what panes are open here.
    expect(verdict.ok === false && verdict.message).toBe('there is no pane t_secret in this project')
  })

  it('cannot type into a pane of a repository it holds no key for', async () => {
    const { alice, shared } = await twoProjects()
    const theirs = decided(alice.service.remoteWrite(shared, { terminalId: 't_secret', data: 'rm -rf /\r', bytes: 9 }))
    expect(theirs.ok).toBe(false)

    // AND IT IS NOT HELD. The owner is never asked about a pane this teammate
    // could not have been offered: a prompt is a fact about the pane existing,
    // shown to the owner and — because a held write waits where a refused one
    // returns at once — legible from the other end as well. So the answer is
    // the refusal, immediately, and it is byte-identical to the one a pane id
    // nobody has ever had gets.
    const invented = decided(alice.service.remoteWrite(shared, { terminalId: 't_nothing', data: 'x', bytes: 1 }))
    expect(theirs).toEqual(invented)
  })

  it('cannot reach anything by claiming the other repository’s project key', async () => {
    const { alice, forged } = await twoProjects()
    // No link exists for that pair, so nothing is registered under that
    // connection id — which is the refusal, and it covers both directions.
    expect(alice.service.remoteRead(forged, 't_secret').ok).toBe(false)
    expect(decided(alice.service.remoteWrite(forged, { terminalId: 't_secret', data: 'x', bytes: 1 })).ok).toBe(false)
  })

  it('is refused at the next keystroke once its key leaves the roster', async () => {
    const { alice, openPath, shared } = await twoProjects()
    expect(decided(alice.service.remoteWrite(shared, { terminalId: 't_open', data: 'x', bytes: 1 })).ok).toBe(true)

    // The revocation: the key is removed from `.teamree/members` and the
    // service re-reads, which is what a `git pull` of the removal does.
    await rm(join(openPath, ...MEMBERS_DIR_SEGMENTS, `mallory${MEMBER_FILE_SUFFIX}`))
    await alice.service.reconcile()

    const verdict = decided(alice.service.remoteWrite(shared, { terminalId: 't_open', data: 'x', bytes: 1 }))
    expect(verdict.ok).toBe(false)
    expect(alice.service.remoteRead(shared, 't_open').ok).toBe(false)
  })
})
