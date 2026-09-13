import { createHash, randomBytes, randomInt, sign } from 'node:crypto'

export interface PersonaGateway {
  create(): Promise<{ relayToken: string; relaySecret: string; relaySessionAccessToken: string }>
  issue(): Promise<string>
  claim(session: { relayToken: string; relaySecret: string; privacyPassToken: string }): Promise<unknown>
}
export type Invitation = { token: string; handle: string; publicKey: string; expiresAt: number }
type Session = {
  invitation: Invitation
  expiresAt: number
  sequence: number[]
  game: boolean
  attempts: number
  persona?: { relayToken: string; relaySecret: string; relaySessionAccessToken: string; privacyPassToken: string }
  busy: boolean
  failed: boolean
  result?: { memberFile: string; credentialId: string; handle: string }
}
export const CREW = ['Navigator', 'Builder', 'Gardener', 'Explorer']

export class Enrollment {
  private sessions = new Map<string, Session>()
  constructor(
    private options: {
      teamId: string
      signingKey: string
      invitations: Invitation[]
      persona: PersonaGateway
      now?: () => number
    }
  ) {}
  private now() {
    return (this.options.now ?? Date.now)()
  }
  start(invite: string) {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id)
    const invitation = this.options.invitations.find((item) => item.token === invite && item.expiresAt > this.now())
    if (!invitation) throw new Error('Invitation is invalid or expired. Ask your team owner for a new one.')
    // A bounded number of attempts per invitation prevents unbounded sessions and API spend.
    if (
      [...this.sessions.values()].filter((item) => item.invitation === invitation).length >= 3 ||
      this.sessions.size >= 1000
    ) {
      throw new Error('Too many attempts. Try again after the current sessions expire.')
    }
    const id = randomBytes(32).toString('base64url')
    const sequence = Array.from({ length: 4 }, () => randomInt(CREW.length))
    const expiresAt = Math.min(this.now() + 30 * 60_000, invitation.expiresAt)
    this.sessions.set(id, { invitation, expiresAt, sequence, game: false, attempts: 0, busy: false, failed: false })
    return { id, sequence, crew: CREW, expiresAt, handle: invitation.handle, teamId: this.options.teamId }
  }
  private get(id: string) {
    const session = this.sessions.get(id)
    if (!session || session.expiresAt <= this.now())
      throw new Error('Session expired. Start again with your invitation.')
    if (session.failed) throw new Error('Verification did not pass. Start a new attempt or contact your team owner.')
    return session
  }
  game(id: string, moves: unknown) {
    const session = this.get(id)
    if (session.game) return
    if (++session.attempts > 5) throw new Error('Game attempts exhausted. Start again.')
    if (
      !Array.isArray(moves) ||
      moves.length !== session.sequence.length ||
      !moves.every((move, index) => move === session.sequence[index])
    )
      throw new Error('That route does not match. Try the sequence again.')
    session.game = true
  }
  async persona(id: string) {
    const session = this.get(id)
    if (!session.game) throw new Error('Complete the crew game first.')
    if (session.persona) return { accessToken: session.persona.relaySessionAccessToken }
    if (session.busy) throw new Error('Verification is already being prepared.')
    session.busy = true
    try {
      const relay = await this.options.persona.create()
      const privacyPassToken = await this.options.persona.issue()
      this.get(id)
      session.persona = { ...relay, privacyPassToken }
      return { accessToken: relay.relaySessionAccessToken }
    } finally {
      session.busy = false
    }
  }
  async finish(id: string) {
    const session = this.get(id)
    if (session.result) return session.result
    if (!session.game || !session.persona) throw new Error('Complete both verification steps first.')
    if (session.busy) throw new Error('Verification is being checked. Try again shortly.')
    session.busy = true
    try {
      const claim = (await this.options.persona.claim(session.persona)) as {
        claim_type?: string
        claim_result?: string
      }
      this.get(id)
      if (claim?.claim_type !== 'live_human_presence' || claim.claim_result !== 'passed') {
        session.failed = true
        throw new Error('Persona verification did not pass. Contact your team owner or start a new attempt.')
      }
      const { handle, publicKey } = session.invitation
      // Stable for an invitation, so repeating verification cannot evade revocation.
      const credentialId = createHash('sha256').update(session.invitation.token).digest('hex')
      const verifiedAt = this.now()
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          id: credentialId,
          teamId: this.options.teamId,
          handle,
          publicKey,
          humanPresence: true,
          gameCompleted: true,
          verifiedAt
        })
      ).toString('base64url')
      const proof = payload + '.' + sign(null, Buffer.from(payload), this.options.signingKey).toString('base64url')
      session.result = {
        credentialId,
        handle,
        memberFile: [
          '# teamree member — human presence verified by Persona',
          `handle: ${handle}`,
          `key: x25519 ${publicKey}`,
          `added: ${new Date(verifiedAt).toISOString().slice(0, 10)}`,
          `human-proof: ${proof}`,
          ''
        ].join('\n')
      }
      return session.result
    } finally {
      session.busy = false
    }
  }
}
