import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Enrollment } from './enrollment'
import { verifyHumanMembership } from '../../src/main/teamwork/humanMembership'

const keys = generateKeyPairSync('ed25519')
const signingKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const issuerPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
function setup(claim: unknown = { claim_type: 'live_human_presence', claim_result: 'passed' }) {
  let now = 1000
  const invitation = {
    token: 'test-invite',
    handle: 'alice',
    publicKey: Buffer.alloc(32, 1).toString('base64'),
    expiresAt: 9999999
  }
  const provider = {
    create: vi.fn(async () => ({ relayToken: 'token', relaySecret: 'secret', relaySessionAccessToken: 'access' })),
    issue: vi.fn(async () => 'pass'),
    claim: vi.fn(async () => claim)
  }
  const enrollment = new Enrollment({
    teamId: 'crew',
    signingKey,
    invitations: [invitation],
    persona: provider,
    now: () => now
  })
  return {
    enrollment,
    invitation,
    provider,
    setNow: (value: number) => {
      now = value
    }
  }
}
describe('human worker enrollment', () => {
  it('requires a server claim, then binds the proof to team, handle and key', async () => {
    const { enrollment, invitation, provider } = setup()
    const session = enrollment.start(invitation.token)
    await expect(enrollment.finish(session.id)).rejects.toThrow('Complete Persona verification first')
    expect(await enrollment.persona(session.id)).toEqual({ accessToken: 'access' })
    await enrollment.persona(session.id)
    expect(provider.create).toHaveBeenCalledTimes(1)
    const result = await enrollment.finish(session.id)
    expect(await enrollment.finish(session.id)).toEqual(result)
    expect(provider.claim).toHaveBeenCalledTimes(1)
    const token = /human-proof: (.+)/.exec(result.memberFile)![1]!
    const policy = { teamId: 'crew', issuerPublicKey, revoked: [] }
    expect(verifyHumanMembership(token, policy, invitation)).toBe(true)
    expect(verifyHumanMembership(token + 'x', policy, invitation)).toBe(false)
    expect(verifyHumanMembership(token, { ...policy, teamId: 'other' }, invitation)).toBe(false)
    expect(verifyHumanMembership(token, policy, { ...invitation, handle: 'bob' })).toBe(false)
    expect(verifyHumanMembership(token, policy, { ...invitation, publicKey: 'other' })).toBe(false)
    expect(verifyHumanMembership(token, { ...policy, revoked: [result.credentialId] }, invitation)).toBe(false)
    expect(result.memberFile).not.toContain('secret')
  })
  it.each([
    { claim_type: 'live_human_presence', claim_result: 'failed' },
    { claim_type: 'age_over_18', claim_result: 'passed' },
    null
  ])('rejects invalid Persona result %j', async (claim) => {
    const { enrollment, invitation } = setup(claim)
    const session = enrollment.start(invitation.token)
    await enrollment.persona(session.id)
    await expect(enrollment.finish(session.id)).rejects.toThrow('did not pass')
    await expect(enrollment.finish(session.id)).rejects.toThrow('did not pass')
  })
  it('expires sessions and rejects unknown invitations', async () => {
    const { enrollment, invitation, setNow } = setup()
    expect(() => enrollment.start('wrong')).toThrow('Invitation')
    const session = enrollment.start(invitation.token)
    setNow(session.expiresAt)
    await expect(enrollment.persona(session.id)).rejects.toThrow('expired')
    await expect(enrollment.finish(session.id)).rejects.toThrow('expired')
  })
  it('limits session creation per invitation', () => {
    const { enrollment, invitation } = setup()
    for (let i = 0; i < 3; i++) enrollment.start(invitation.token)
    expect(() => enrollment.start(invitation.token)).toThrow('Too many')
  })
})
