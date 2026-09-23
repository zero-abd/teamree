// Where the relay is: `.teamree/relay` in the repository (a team-wide fact, reviewed in a diff), overridden
// for one run by `TEAMREE_RELAY_URL` (for an ephemeral `cloudflared` URL). Deliberately no default: a URL
// baked in here would be a server this project is quietly asking a team to trust. A relay never sees content.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseRelayUrl } from '../../../shared/relayUrl'

// The grammar is shared with the window, which refuses an address while it is being typed.
export { parseRelayUrl, RELAY_ENDPOINT_PATH, websocketFormOf } from '../../../shared/relayUrl'
export type { RelayUrlParse } from '../../../shared/relayUrl'

/** Where a project records its relay, relative to the checkout root. */
export const RELAY_FILE_SEGMENTS = ['.teamree', 'relay'] as const

export const RELAY_FILE_NAME = RELAY_FILE_SEGMENTS.join('/')

/** Overrides the committed file, for one run of one machine. */
export const RELAY_URL_ENV = 'TEAMREE_RELAY_URL'

export type RelayLocation = {
  url: string
  /** Which of the two said so, because a surprising URL needs a source. */
  source: 'repository' | 'environment'
}

export type RelayConfig =
  | { configured: true; location: RelayLocation }
  /** Says why, in words a user can act on, rather than reporting a bare false. */
  | { configured: false; reason: string }

const TEMPLATE = [
  '# The relay this project meets on.',
  '#',
  '# Two machines behind two routers cannot reach each other, so each opens an',
  '# outbound WebSocket to a relay your team runs and the relay splices them',
  '# together. It is never trusted with content: everything across it is a Noise',
  '# session keyed from the public keys in .teamree/members, so the relay sees',
  '# ciphertext and nothing else.',
  '#',
  '# One ws:// or wss:// URL, ending in the relay’s path. See relay/README.md.',
  ''
].join('\n')

/** What to write into an empty `.teamree/relay`, for whoever sets one up. */
export function relayFileTemplate(url: string): string {
  return `${TEMPLATE}${url}\n`
}

/**
 * Writes the relay file and stops there: not staged, committed or pushed. Replaces what is there, unlike
 * a member file: a team has exactly one relay, and the change is reviewed in the diff the author commits.
 */
export async function writeRelayFile(projectPath: string, url: string): Promise<string> {
  const target = join(projectPath, ...RELAY_FILE_SEGMENTS)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, relayFileTemplate(url), 'utf8')
  return RELAY_FILE_NAME
}

/** The relay for one project. `env` is passed in so a test can say what the environment holds. */
export async function readRelayConfig(projectPath: string, env: NodeJS.ProcessEnv = process.env): Promise<RelayConfig> {
  const override = relayOverride(env)
  if (override !== null) {
    const parsed = parseRelayUrl(override)
    if (!parsed.ok) return { configured: false, reason: `${RELAY_URL_ENV} is not a relay URL: ${parsed.reason}` }
    return { configured: true, location: { url: parsed.url, source: 'environment' } }
  }

  const file = await readRelayFile(projectPath)
  if (!file.ok) return { configured: false, reason: file.reason }
  return { configured: true, location: { url: file.url, source: 'repository' } }
}

/** The override this process can see, or null when there is none to see. */
export function relayOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env[RELAY_URL_ENV] ?? '').trim() || null
}

export type RelayFileRead = { ok: true; url: string } | { ok: false; reason: string }

/**
 * What the file in the checkout says, on its own. Read separately from the environment because a person
 * asking why they are not meeting anybody needs to see both answers rather than whichever one won.
 */
export async function readRelayFile(projectPath: string): Promise<RelayFileRead> {
  let text: string
  try {
    text = await readFile(join(projectPath, ...RELAY_FILE_SEGMENTS), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        reason: `no ${RELAY_FILE_NAME} in this project, so teamree does not know which relay your team meets on`
      }
    }
    return { ok: false, reason: `${RELAY_FILE_NAME} could not be read: ${errorCode(error)}` }
  }

  const line = firstMeaningfulLine(text)
  if (line === undefined) return { ok: false, reason: `${RELAY_FILE_NAME} has no URL in it` }

  const parsed = parseRelayUrl(line)
  if (!parsed.ok) return { ok: false, reason: `${RELAY_FILE_NAME} is not a relay URL: ${parsed.reason}` }
  return { ok: true, url: parsed.url }
}

/** Comments and blank lines are skipped, the way the member files' are. */
function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed
  }
  return undefined
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error'
}
