// The one pasteable thing, and the argument for why it is allowed to exist.
//
// Teamwork has no invitation in the sense most products mean: there is no token
// that lets somebody in, because being in *is* being able to push a key to the
// repository. That property is the whole security model and nothing here
// touches it. What this file carries is the other thing a joiner needs and
// currently has to be told in prose — *which* repository, *which* relay, what
// the project is called, and who asked — four facts that are already public,
// already committed, and already typed by hand into a chat window today.
//
// So the link is a message, not a key. Reading it grants nothing. Holding it
// grants nothing. A person who accepts one still has to push their own public
// key to that repository, and if they cannot push, everything below still ends
// in a refusal that says so. The only thing it removes is the retyping.
//
// Three shape decisions, each with a reason:
//
// **One token, no spaces, no line breaks.** It has to survive being pasted into
// a chat message, a commit body, an issue comment and an agent's prompt. Every
// one of those wraps, re-flows or trims multi-line text, and a link that broke
// when it wrapped would fail in exactly the place it is meant to work.
//
// **Readable rather than packed.** A base64 blob would be shorter and would
// look exactly like a bearer token, which is the one thing this must not be
// mistaken for. Every field here is legible in the string itself, so somebody
// can see for themselves that it names a repository and a relay and carries no
// secret. A format nobody can read is a format nobody can check.
//
// **A version, first.** An older build handed a newer link must say so rather
// than silently ignoring a field it does not know about. Dropping a field it
// cannot see would be this CLI acting on half an instruction, which is the
// failure mode the rest of this codebase spends its comments avoiding.

/** What `teamree team invite` writes and `teamree team accept` reads. */
export type Invitation = {
  /**
   * The repository, as the sender's checkout names it — a URL or the absolute
   * path a shared volume is mounted at. This is the load-bearing field: two
   * checkouts are the same project when their normalised origins match, so a
   * link without it names nothing.
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
 * The only version this build writes, and the only one it reads.
 *
 * Bumped when a field stops being optional or changes meaning — never for one
 * added field a reader may ignore, because `parse` below already ignores
 * unknown parameters and an older build dropping decoration is fine. It is a
 * dropped *instruction* that is not.
 */
export const INVITATION_VERSION = '1'

/**
 * The scheme and authority, together, because they are one literal.
 *
 * `teamree://join?...` rather than a bare `teamree:` so the platform URL parser
 * handles the escaping — the origin and relay are themselves URLs and nesting
 * one inside another by hand is how a `&` in a path becomes a lost field.
 */
const PREFIX = 'teamree://join?'

/** The same literal, for finding it inside a message whatever its case. */
const PREFIX_PATTERN = /teamree:\/\/join\?/i

/**
 * What a chat client, a shell or a person is likely to have left on the end.
 *
 * `>` and a backtick are how people paste URLs into messages that would
 * otherwise mangle them; the rest is the full stop somebody put after it, or
 * the bracket the link was written inside. Every one of these is safe to peel
 * because the format never ends in one — a query string ends in a value, and
 * `URLSearchParams` percent-encodes anything here that is genuinely part of it.
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
 * Makes sure the link cannot end in a character `TRAILING` would peel off it.
 *
 * `URLSearchParams` escapes almost everything, and `.` is the one character it
 * leaves alone that a sentence also ends with. Without this, a last field ending
 * in a full stop and a link written at the end of a sentence are the same
 * string, and the reader below has to guess — which it would do wrongly for one
 * of them, silently, every time.
 *
 * Escaping it here rather than guessing there is what makes the round trip an
 * identity: `%2E` decodes back to `.`, and the tolerance for punctuation stays
 * as generous as it was.
 */
function terminate(query: string): string {
  return query.endsWith('.') ? `${query.slice(0, -1)}%2E` : query
}

/**
 * The repository's address with this machine's credential taken out of it.
 *
 * An `origin` of `https://x-access-token:ghp_…@github.com/acme/api.git` is an
 * ordinary thing for a checkout to have, and it is a secret belonging to one
 * person on one machine. An invitation is a line somebody pastes into a chat
 * window, so putting that string in it verbatim would be handing a token to a
 * room — and it would be doing it under the heading "everything in this is
 * public", which is worse than doing it plainly.
 *
 * Only http and https, because those are the schemes where the part before the
 * `@` is a credential. In `git@github.com:acme/api.git` and in
 * `ssh://git@host/path` it is the ssh user, it is not secret, and removing it
 * would produce an address that does not work.
 *
 * `removed` is reported rather than swallowed: a person whose origin carries a
 * token should be told that the line they are about to send is not the string
 * their own `git remote -v` prints.
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
  /**
   * `reason` completes "…is not a teamree invitation: <reason>"; `hint` is the
   * one thing to do about it. Both are sentences the CLI prints as they are,
   * because a parse failure here is somebody holding the wrong string and the
   * remedy is always to ask the sender for another one.
   */
  | { ok: false; reason: string; hint: string }

/**
 * Reads a link out of whatever it arrived inside.
 *
 * Deliberately tolerant about the surroundings and strict about the contents.
 * What a person actually has is a chat message with a sentence around the link,
 * and refusing that would send them back to select exactly the right characters
 * with a mouse — the same tolerance `.teamree/relay` already extends to a
 * pasted relay URL. What it will not do is guess at a missing field: a link
 * with no origin is not an invitation with a gap in it, it is a different
 * string that happens to start the same way.
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
    // A percent-encoded escape sequence is still one whitespace-free token, so
    // the format carries control characters perfectly well and every field here
    // is printed — into this command's own report, into its refusals, and for
    // the origin into somebody's `.git/config`. A link that can move the cursor
    // can erase the sentence above it, which is the whole of "never claim
    // something it does not know" undone by a string somebody was sent.
    // `src/shared/origin.ts` refuses these in a path origin for the same reason.
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
 * The link inside a message, or undefined when there is not one.
 *
 * The token runs to the first whitespace, because that is the one character the
 * format guarantees it does not contain; trailing punctuation is peeled off
 * afterwards rather than excluded by the pattern, so a `?` that is part of a
 * query and a `?` that ends a question are told apart by position.
 */
function findInvitation(raw: string): string | undefined {
  // Matched case-insensitively against the original rather than against a
  // lowercased copy: a character whose lowercase is longer than itself — `İ` is
  // two — shifts every index after it, and the token would then be sliced one
  // character in and refused as unreadable.
  const at = PREFIX_PATTERN.exec(raw)?.index ?? -1
  if (at === -1) return undefined
  const token = (raw.slice(at).split(/\s/)[0] as string).replace(TRAILING, '')
  return token.length > PREFIX.length ? token : undefined
}
