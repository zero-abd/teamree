import { generateKeyPairSync, createPublicKey, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [teamId, handle, publicKey] = process.argv.slice(2)
if (
  !teamId ||
  !handle ||
  !/^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/.test(handle) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(handle) ||
  !publicKey ||
  !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)
) {
  throw new Error(
    'Usage: node scripts/invite.mjs <team-id> <handle: 2-48 lowercase letters/digits/hyphens> <device-public-key>'
  )
}
const directory = resolve('.local')
await mkdir(directory, { recursive: true })
const keyPath = resolve(directory, 'issuer.pem')
let signingKey
try {
  signingKey = await readFile(keyPath, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  signingKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await writeFile(keyPath, signingKey, { flag: 'wx', mode: 0o600 })
}
const policyPath = resolve(directory, 'human-policy.json')
const issuerPublicKey = createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }).toString()
try {
  const existing = JSON.parse(await readFile(policyPath, 'utf8'))
  if (existing.teamId !== teamId || existing.issuerPublicKey !== issuerPublicKey)
    throw new Error('This installation already belongs to another team or signing key')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(policyPath, JSON.stringify({ teamId, issuerPublicKey, revoked: [] }, null, 2) + '\n', { flag: 'wx' })
}
const invitesPath = resolve(directory, 'invitations.json')
let invitations = []
try {
  invitations = JSON.parse(await readFile(invitesPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (invitations.some((item) => item.handle === handle || item.publicKey === publicKey)) {
  throw new Error(
    'An invitation already exists for this handle or key. Edit the private invitations file to replace it intentionally.'
  )
}
const token = randomBytes(32).toString('base64url')
invitations.push({ token, handle, publicKey, expiresAt: Date.now() + 24 * 60 * 60_000 })
await writeFile(invitesPath, JSON.stringify(invitations, null, 2) + '\n', { mode: 0o600 })
console.log(`Invitation for ${handle} (expires in 24 hours): ${token}`)
console.log(`Public policy: ${policyPath}`)
console.log('Restart the membership server to load the invitation. Share the code privately with this teammate.')
