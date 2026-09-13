import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { readRoster } from './roster'

it('filters unsigned, forged and revoked roster entries and fails closed on broken policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-roster-'))
  try {
    await mkdir(join(root, '.teamree', 'members'), { recursive: true })
    const keys = generateKeyPairSync('ed25519')
    const publicKey = Buffer.alloc(32, 1).toString('base64')
    const member = `handle: alice\nkey: x25519 ${publicKey}\nadded: 2026-09-13\n`
    const path = join(root, '.teamree', 'members', 'alice.pub')
    const policyPath = join(root, '.teamree', 'human-policy.json')
    await writeFile(path, member)
    expect((await readRoster(root)).entries).toHaveLength(1)
    const policy = {
      teamId: 'crew',
      issuerPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      revoked: [] as string[]
    }
    await writeFile(policyPath, JSON.stringify(policy))
    expect((await readRoster(root)).entries).toHaveLength(0)
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        id: 'id',
        teamId: 'crew',
        handle: 'alice',
        publicKey,
        humanPresence: true,
        verifiedAt: 1000
      })
    ).toString('base64url')
    const proof = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}`
    await writeFile(path, member + `human-proof: ${proof}\n`)
    expect((await readRoster(root)).entries).toHaveLength(1)
    await writeFile(path, member + `human-proof: ${proof}x\n`)
    expect((await readRoster(root)).entries).toHaveLength(0)
    await writeFile(path, member + `human-proof: ${proof}\n`)
    await writeFile(policyPath, JSON.stringify({ ...policy, revoked: ['id'] }))
    expect((await readRoster(root)).entries).toHaveLength(0)
    await writeFile(policyPath, '{broken')
    const roster = await readRoster(root)
    expect(roster.entries).toHaveLength(0)
    expect(roster.problems[0]?.file).toBe('.teamree/human-policy.json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
