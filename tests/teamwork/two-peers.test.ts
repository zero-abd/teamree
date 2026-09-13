// The two-peer harness, tested on the harness rather than on teamwork.
//
// What it owes every suite built on it: two runtimes that do not share state,
// two identities that are the runtimes' own, a roster that a push carries from
// one checkout to the other, a relay the pair actually meet on, and a teardown
// that leaves nothing behind. The last one matters more than it sounds — a
// harness that leaks a runtime poisons the run after it rather than failing its
// own.
//
// The story the harness exists to tell is in scenario.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'
import { memberKeyPath } from '../../scripts/teamwork/identity.mjs'

const RELAY_BUILT = relayIsBuilt()

let peers: Awaited<ReturnType<typeof startTwoPeers>>

beforeAll(async () => {
  peers = await startTwoPeers({ handles: ['ana', 'bo'] })
}, 120_000)

// A safety net, not the teardown under test: the last test below stops the
// harness and asserts on what it left, which is the only point at which that
// question can be asked. `stop` is idempotent, so running twice costs nothing.
afterAll(async () => {
  await peers.stop()
}, 60_000)

describe('two peers on one machine', () => {
  it('gives each peer its own runtime process', async () => {
    const [leader, joiner] = [await peers.leader.call('status.get'), await peers.joiner.call('status.get')]
    expect(leader.pid).toBeGreaterThan(0)
    expect(joiner.pid).toBeGreaterThan(0)
    expect(leader.pid).not.toBe(joiner.pid)
  })

  it('gives each peer its own endpoint, derived from its own data directory', () => {
    expect(peers.leader.discovery.endpoint).not.toBe(peers.joiner.discovery.endpoint)
    expect(peers.leader.userDataDir).not.toBe(peers.joiner.userDataDir)
  })

  it('keeps one peer’s workspace out of the other’s', async () => {
    // The failure this guards against is a harness that looks like two peers and
    // is one: two runtimes accidentally sharing a store would agree about
    // everything, and every teamwork assertion built on it would pass vacuously.
    await peers.leader.call('project.add', { path: peers.leader.repoPath })

    expect(await peers.leader.call('project.list')).toHaveLength(1)
    expect(await peers.joiner.call('project.list')).toHaveLength(0)
  })

  it('gives each peer the keypair its own runtime generated, and no copy of the secret', async () => {
    // Asked of the runtime rather than minted here. A harness that made its own
    // keys would fill the roster with keys the app has never heard of, and
    // every handshake would then fail for a reason no assertion explains.
    const [ana, bo] = [await peers.leader.whoAmI(), await peers.joiner.whoAmI()]
    expect(ana.publicKey).not.toBe(bo.publicKey)
    for (const identity of [ana, bo]) {
      // Base64 of the raw 32 bytes, which is what the member file carries.
      expect(Buffer.from(identity.publicKey, 'base64')).toHaveLength(32)
    }

    for (const peer of peers.peers) {
      // The private half is in the app's own data directory and in no checkout,
      // which is the one thing `docs/teamwork.md` promises about it.
      expect(existsSync(join(peer.userDataDir, 'identity.key'))).toBe(true)
      expect(existsSync(join(peer.repoPath, '.teamree', 'identity.key'))).toBe(false)
    }
  })

  it('gives each peer its own clone rather than a shared checkout', () => {
    expect(peers.leader.repoPath).not.toBe(peers.joiner.repoPath)
    for (const peer of peers.peers) {
      expect(existsSync(join(peer.repoPath, 'package.json'))).toBe(true)
      expect(existsSync(join(peer.repoPath, '.teamree', 'members'))).toBe(true)
    }
  })

  it('carries a member’s key to the other peer only once it is pushed', async () => {
    await peers.leader.addSelfToRoster()

    // Written but not committed: the key exists on the leader's disk and is
    // invisible to everybody else. This is the most common way a team gets
    // stuck, so it is asserted rather than assumed.
    expect(existsSync(memberKeyPath(peers.leader.repoPath, 'ana'))).toBe(true)
    await peers.joiner.gitPull()
    expect(await peers.joiner.roster()).toEqual([])

    await peers.leader.commit('Add ana to the team', ['.teamree'])
    await peers.leader.gitPush()
    await peers.joiner.gitPull()

    const roster = await peers.joiner.roster()
    expect(roster.map((member) => member.handle)).toEqual(['ana'])
    expect(roster[0]?.publicKey).toBe((await peers.leader.whoAmI()).publicKey)
  }, 30_000)

  it('lets the second member add themselves on top of the first', async () => {
    await peers.joiner.addSelfToRoster()
    await peers.joiner.commit('Add bo to the team', ['.teamree'])
    await peers.joiner.gitPush()
    await peers.leader.gitPull()

    expect((await peers.leader.roster()).map((member) => member.handle)).toEqual(['ana', 'bo'])
  }, 30_000)

  it('runs a real PTY in a real worktree of the example repository', async () => {
    const [project] = await peers.leader.call('project.list')
    const created = await peers.leader.call('worktree.create', { projectId: project.id, name: 'try the suite' })

    let worktree = created
    for (let attempt = 0; attempt < 120 && worktree.state === 'creating'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      worktree = await peers.leader.call('worktree.get', { worktreeId: created.id })
    }
    expect(worktree.state, worktree.error).toBe('ready')

    // The example earns its place here: an agent started in a worktree of it has
    // something to run that says something. An empty fixture proves nothing.
    const suite = execFileSync('npm', ['test'], { cwd: worktree.path, encoding: 'utf8' })
    expect(suite).toMatch(/# fail 0/)
  }, 90_000)

  it.skipIf(!RELAY_BUILT)(
    'puts the two of them on a real relay and waits until they have met',
    async () => {
      await peers.linkPeers()

      // Both directions, because a link is two Noise sessions and either one
      // could be the half that came up.
      for (const peer of peers.peers) {
        const [link] = await peer.links()
        expect(link?.phase, JSON.stringify(link)).toBe('connected')
      }
      expect((await peers.leader.links())[0]?.handle).toBe('bo')
      expect((await peers.joiner.links())[0]?.handle).toBe('ana')

      // And the relay is the team's, in the repository, where a diff shows it —
      // not a per-machine setting one of them typed.
      const relay = await peers.joiner.call('teamwork.relay', { projectId: peers.joiner.projectId })
      expect(relay.source).toBe('repository')
      expect(relay.url).toBe(peers.relay.url)
    },
    90_000
  )

  // Last on purpose: teardown can only be checked by doing it. Every assertion
  // in scenario.test.ts is made by a harness like this one — two runtimes, a
  // relay and three clones — so a harness that leaked any of it would poison
  // the run after it rather than fail its own.
  it('tears down completely, leaving no runtime, socket or directory behind', async () => {
    const endpoints = peers.peers.map((peer) => peer.discovery.endpoint)

    expect(await peers.stop()).toEqual([])

    for (const peer of peers.peers) {
      expect(peer.child.exitCode === null && peer.child.signalCode === null).toBe(false)
      expect(existsSync(peer.discoveryPath)).toBe(false)
    }
    for (const endpoint of endpoints) expect(existsSync(endpoint)).toBe(false)
    expect(existsSync(peers.root)).toBe(false)
  }, 60_000)
})
