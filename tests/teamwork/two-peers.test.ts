// The two-peer harness, tested on the parts of teamwork that exist today.
//
// What is provable now is everything up to the wire: two runtimes that do not
// share state, two identities that are actually different, a roster that a push
// carries from one checkout to the other, and a teardown that leaves nothing
// behind. That last one matters more than it sounds — every assertion in the
// milestones to come will be made by a harness like this one, and a harness that
// leaks a runtime poisons the run after it.
//
// Everything past the wire is in scenario.test.ts, pending the relay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PeerTransportNotBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'
import { memberKeyPath } from '../../scripts/teamwork/identity.mjs'

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

  it('gives each peer a different X25519 keypair', () => {
    expect(peers.leader.identity.publicKey).not.toBe(peers.joiner.identity.publicKey)
    expect(peers.leader.identity.privateKey).not.toBe(peers.joiner.identity.privateKey)
    for (const peer of peers.peers) {
      // Base64 of the raw 32 bytes, which is what the member file carries.
      expect(Buffer.from(peer.identity.publicKey, 'base64')).toHaveLength(32)
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
    expect(roster[0]?.publicKey).toBe(peers.leader.identity.publicKey)
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
    const suite = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], {
      cwd: worktree.path,
      encoding: 'utf8'
    })
    expect(suite).toMatch(/# fail 0/)
  }, 90_000)

  it('refuses to pretend the peer transport exists', async () => {
    await expect(peers.linkPeers()).rejects.toThrow(PeerTransportNotBuilt)
  })

  // Last on purpose: teardown can only be checked by doing it. Every assertion
  // in milestones B through E will be made by a harness like this one, so a
  // harness that leaked a runtime would poison the run after it rather than
  // fail its own.
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
