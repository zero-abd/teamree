import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createPrivateKey } from 'node:crypto'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Enrollment, type Invitation } from './enrollment'

// SDK 0.4.1 ships CommonJS getters that Node cannot expose as named ESM exports.
const { Persona } = createRequire(import.meta.url)('@persona/sdk-node') as typeof import('@persona/sdk-node')

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} before starting the membership server`)
  return value
}
const origin = new URL(required('MEMBERSHIP_ORIGIN')).origin
if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
  throw new Error('Use HTTPS outside localhost')
}
const signingKey = await readFile(required('MEMBERSHIP_SIGNING_KEY_FILE'), 'utf8')
if (createPrivateKey(signingKey).asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 signing key')
const invitations: Invitation[] = JSON.parse(await readFile(required('MEMBERSHIP_INVITATIONS_FILE'), 'utf8'))
if (
  !Array.isArray(invitations) ||
  invitations.some(
    (item) =>
      typeof item.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43,}$/.test(item.token) ||
      typeof item.handle !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/.test(item.handle) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(item.handle) ||
      typeof item.publicKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(item.publicKey) ||
      !Number.isSafeInteger(item.expiresAt)
  )
)
  throw new Error('Invalid invitation configuration')
const persona = new Persona({ apiKey: required('PERSONA_API_KEY') })
const sandbox = process.env.PERSONA_SANDBOX === 'true'
const enrollment = new Enrollment({
  teamId: required('MEMBERSHIP_TEAM_ID'),
  signingKey,
  invitations,
  persona: {
    create: () => persona.relays.create({ claimType: 'live_human_presence', encryptionKeyPem: null, sandbox }),
    issue: async () => (await persona.relays.issuePrivacyPass({ claimType: 'live_human_presence' })).privacyPassToken,
    claim: async (session) => {
      const result = await persona.relays.generateClaim(session)
      return JSON.parse(result.claimPayload)
    }
  }
})
const root = resolve('dist')
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  const json = (code: number, value: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  }
  try {
    const path = new URL(req.url ?? '/', origin).pathname
    if (req.method === 'POST' && path.startsWith('/api/')) {
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) {
        json(403, { error: 'Request origin is not allowed' })
        return
      }
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (Buffer.byteLength(raw) > 4096) {
          json(413, { error: 'Request too large' })
          return
        }
      }
      const body = JSON.parse(raw)
      if (path === '/api/start') {
        json(200, enrollment.start(String(body.invite)))
        return
      }
      const id = String(body.id)
      if (path === '/api/game') {
        enrollment.game(id, body.moves)
        json(200, { ok: true })
        return
      }
      if (path === '/api/persona') {
        json(200, await enrollment.persona(id))
        return
      }
      if (path === '/api/finish') {
        json(200, await enrollment.finish(id))
        return
      }
      json(404, { error: 'Not found' })
      return
    }
    if (req.method !== 'GET') {
      json(405, { error: 'Method not allowed' })
      return
    }
    const file = path === '/' ? '/index.html' : path
    if (file !== '/index.html' && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(file)) {
      json(404, { error: 'Not found' })
      return
    }
    const content = await readFile(resolve(root, '.' + file))
    res.setHeader(
      'Content-Type',
      file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    )
    res.end(content)
  } catch (error) {
    // Do not return SDK responses, tokens, or provider diagnostics to the browser.
    const message =
      error instanceof Error &&
      /^(Invitation|Too many|Session|Verification|Complete|Game|That route|Persona verification)/.test(error.message)
        ? error.message
        : 'Unable to complete this step. Retry, or contact your team owner.'
    json(400, { error: message })
  }
})
server.requestTimeout = 15_000
server.listen(Number(process.env.PORT ?? 4319), process.env.HOST ?? '127.0.0.1', () =>
  console.log(`Membership server: ${origin}`)
)
