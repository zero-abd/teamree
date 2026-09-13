import { verify, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type HumanPolicy = { teamId: string; issuerPublicKey: string; revoked: string[] }

/** Missing means opt-in is off; malformed or unreadable policy must fail closed. */
export async function readHumanPolicy(projectPath: string): Promise<HumanPolicy | null> {
  let raw: string
  try {
    raw = await readFile(join(projectPath, '.teamree', 'human-policy.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const policy = JSON.parse(raw)
  if (
    typeof policy.teamId !== 'string' ||
    !policy.teamId ||
    typeof policy.issuerPublicKey !== 'string' ||
    !Array.isArray(policy.revoked) ||
    !policy.revoked.every((id: unknown) => typeof id === 'string') ||
    createPublicKey(policy.issuerPublicKey).asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('Invalid human membership policy')
  }
  return policy
}

export function verifyHumanMembership(
  token: string,
  policy: HumanPolicy,
  member: { publicKey: string; handle: string }
): boolean {
  try {
    if (token.length > 8192) return false
    const parts = token.split('.')
    if (parts.length !== 2) return false
    const [payload, signature] = parts as [string, string]
    if (!verify(null, Buffer.from(payload), policy.issuerPublicKey, Buffer.from(signature, 'base64url'))) return false
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return (
      claim.version === 1 &&
      claim.teamId === policy.teamId &&
      claim.publicKey === member.publicKey &&
      claim.handle === member.handle &&
      claim.humanPresence === true &&
      typeof claim.id === 'string' &&
      !policy.revoked.includes(claim.id) &&
      Number.isSafeInteger(claim.verifiedAt) &&
      claim.verifiedAt > 0
    )
  } catch {
    return false
  }
}
