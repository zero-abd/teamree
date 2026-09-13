// Where the relay is, and why it is written down there.
//
// THE DECISION: the relay URL lives in the repository, at `.teamree/relay`,
// beside the member keys — and `TEAMREE_RELAY_URL` in the environment overrides
// it for one run. There is deliberately no default: teams self-host, nobody
// runs one for them, and a URL baked in here would be either a lie or a server
// this project is quietly asking a team to trust.
//
// The repository is the right place for the same reason the roster is. A relay
// is a team-wide fact, not a per-machine preference: everybody on the team has
// to name the same one or they never meet. Anywhere else — a settings pane, a
// per-machine config file — is a second list to keep in step with the first,
// which is the thing `docs/teamwork.md` spends its identity section avoiding.
// Committing it means one person deploys a relay, pushes a one-line file, and
// the team is connected, with the change visible in a diff like every other
// decision about the project.
//
// The obvious objection — whoever can push can point the team at a relay they
// run — costs nothing that is not already conceded. A relay is never trusted
// with content: `IK` authenticates both static keys, so the worst a hostile
// relay does is refuse to pair or drop frames, which is denial of service by
// someone who could also just delete everyone's keys. `docs/teamwork.md`
// already says a repository you can push to is a repository whose members you
// can rewrite.
//
// The environment override is for the case the relay's own README describes:
// an ephemeral `cloudflared` URL that changes every time the tunnel restarts.
// That is a thing to try, not a thing to commit, so it goes somewhere that is
// gone when the process is.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseRelayUrl } from '../../../shared/relayUrl'

// The grammar is shared with the window, which has to refuse an address
// while it is being typed rather than after a round trip. Re-exported here
// so the rest of the runtime still asks this module about relay URLs.
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
 * Writes the file that whoever stood the relay up would otherwise write by
 * hand, and stops there: it is not staged, not committed and not pushed, for
 * the same reason a member file is not.
 *
 * Replaces what is there, unlike a member file, which is refused rather than
 * overwritten because it is somebody else's key. A relay is the project's one
 * team-wide fact and a team has exactly one — changing it *is* what setting it
 * means — and the change is reviewed where every other decision about the
 * project is, in the diff the author has to commit.
 */
export async function writeRelayFile(projectPath: string, url: string): Promise<string> {
  const target = join(projectPath, ...RELAY_FILE_SEGMENTS)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, relayFileTemplate(url), 'utf8')
  return RELAY_FILE_NAME
}

/**
 * The relay for one project.
 *
 * `env` is passed in rather than read from `process.env` so a test can say what
 * the environment holds without editing the process it runs in.
 */
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
 * What the file in the checkout says, on its own.
 *
 * Read separately from the environment because the two are worth showing side
 * by side: an override in effect does not stop the team's relay being a fact
 * about this repository, and a person asking why they are not meeting anybody
 * needs to see both answers rather than whichever one won.
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
