// The invitation link: a message, not a key. It carries four public facts
// (repository, relay, project name, sender) and grants nothing; being on a team
// is being able to push a key. One token with no whitespace so it survives
// chat, commit bodies and prompts; readable rather than packed so it cannot be
// mistaken for a bearer token; version first so an older build can say so.

/** What `teamree team invite` writes and `teamree team accept` reads. */
export type Invitation = {
  /**
   * The repository as the sender's checkout names it: a URL or the absolute path
   * a shared volume is mounted at. Two checkouts are one project when their
   * normalised origins match, so a link without it names nothing.
   */
  origin: string
  /** The relay both machines dial out to. Without one, neither ever meets the other. */
  relay: string
  /** What the sender's workspace calls the project. A label, and nothing depends on it. */
  project: string
  /** The sender's roster handle, so the receiver can see whose invitation this is. */
  from: string
}

/**
 * The only version this build writes or reads. Bumped when a field stops being
 * optional or changes meaning, never for an added field a reader may ignore.
 */
export const INVITATION_VERSION = '1'

/**
 * `teamree://join?...` rather than a bare `teamree:` so the platform URL parser
 * handles escaping: origin and relay are URLs themselves, and a `&` in one would lose a field.
 */
const PREFIX = 'teamree://join?'

/** The same literal, for finding it inside a message whatever its case. */
const PREFIX_PATTERN = /teamree:\/\/join\?/i

/**
 * What a chat client, a shell or a person leaves on the end. Safe to peel
 * because the format never ends in one: `URLSearchParams` percent-encodes any that is genuinely part of it.
 */
const TRAILING = /[>)"'`\].,;:!?]+$/

/** Everything a terminal obeys rather than prints, including DEL. */
const CONTROL = /[\u0000-\u001F\u007F]/

export function formatInvitation(invitation: Invitation): string {
  const query = new URLSearchParams({
    v: INVITATION_VERSION,
    origin: invitation.origin,
    relay: invitation.relay,
    project: invitation.project,
    from: invitation.from
  })
  return `${PREFIX}${terminate(query.toString())}`
}

/**
 * Makes sure the link cannot end in a character `TRAILING` would peel: `.` is
 * the one `URLSearchParams` leaves alone that a sentence also ends with.
 */
function terminate(query: string): string {
  return query.endsWith('.') ? `${query.slice(0, -1)}%2E` : query
}

/**
 * The repository's address with this machine's credential taken out: an https
 * origin can carry a token, and the invitation goes into a chat window. Only
 * http and https, since in `git@host:path` the part before `@` is the ssh user
 * and removing it breaks the address. `removed` is reported so the sender knows
 * the line is not what `git remote -v` prints.
 */
export function withoutCredentials(origin: string): { origin: string; removed: boolean } {
  if (!/^https?:\/\//i.test(origin)) return { origin, removed: false }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return { origin, removed: false }
  }
  if (url.username === '' && url.password === '') return { origin, removed: false }
  url.username = ''
  url.password = ''
  return { origin: url.toString(), removed: true }
}

export type InvitationParse =
  | { ok: true; invitation: Invitation }
  /** `reason` completes "…is not a teamree invitation: <reason>"; `hint` is the one thing to do about it. */
  | { ok: false; reason: string; hint: string }

/**
 * Reads a link out of whatever it arrived inside: tolerant about the
 * surroundings, strict about the contents. A missing field is never guessed at.
 */
export function parseInvitation(raw: string): InvitationParse {
  const found = findInvitation(raw)
  if (found === undefined) {
    return {
      ok: false,
      reason: 'it does not contain a teamree invitation',
      hint: `An invitation begins with ${PREFIX} and is one unbroken token. Ask whoever sent it to run \`teamree team invite <project>\` and send the whole line.`
    }
  }

  let url: URL
  try {
    url = new URL(found)
  } catch {
    return {
      ok: false,
      reason: 'it is not a readable link',
      hint: 'Paste the whole invitation, exactly as it was sent, without a line break in the middle of it.'
    }
  }

  const version = url.searchParams.get('v')
  if (version !== INVITATION_VERSION) {
    return {
      ok: false,
      reason:
        version === null
          ? 'it carries no version'
          : `it is a version ${version} invitation and this teamree reads version ${INVITATION_VERSION}`,
      hint:
        version === null
          ? 'Ask whoever sent it to run `teamree team invite <project>` again on a current teamree.'
          : 'Update teamree on this machine, or ask for an invitation from a teamree that matches it.'
    }
  }

  const required = ['origin', 'relay', 'project', 'from'] as const
  const values: Record<string, string> = {}
  for (const field of required) {
    const value = url.searchParams.get(field)?.trim()
    // The format carries percent-encoded control characters fine, and every
    // field is printed, the origin into a `.git/config`: a link that moves the
    // cursor can erase the sentence above it.
    if (value !== undefined && CONTROL.test(value)) {
      return {
        ok: false,
        reason: `its ${field} has a control character in it, which nothing that is really an invitation has`,
        hint: 'Ask whoever sent it to run `teamree team invite <project>` again and send what that printed.'
      }
    }
    if (value === undefined || value === '') {
      return {
        ok: false,
        reason: `it names no ${field}`,
        hint: `An invitation that names no ${field} cannot be acted on. Ask whoever sent it to run \`teamree team invite <project>\` again — it refuses to write one with a field missing.`
      }
    }
    values[field] = value
  }

  return {
    ok: true,
    invitation: {
      origin: values['origin'] as string,
      relay: values['relay'] as string,
      project: values['project'] as string,
      from: values['from'] as string
    }
  }
}

/**
 * The link inside a message, or undefined. The token runs to the first
 * whitespace; trailing punctuation is peeled afterwards, so a `?` in the query
 * and a `?` ending a question are told apart by position.
 */
function findInvitation(raw: string): string | undefined {
  // Against the original, not a lowercased copy: `İ` lowercases to two
  // characters and would shift every index after it.
  const at = PREFIX_PATTERN.exec(raw)?.index ?? -1
  if (at === -1) return undefined
  const token = (raw.slice(at).split(/\s/)[0] as string).replace(TRAILING, '')
  return token.length > PREFIX.length ? token : undefined
}
