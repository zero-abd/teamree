// One line about whether teamwork is working, for the project header.
//
// The whole difficulty is that "no teammates on screen" has six causes and
// five of them are not each other:
//
//   * nobody has set a relay up here — a thing to do, not a fault;
//   * this machine's own key was never pushed — nobody can address it;
//   * the relay cannot be reached — this machine's network, or the relay's;
//   * the relay is fine and the teammate is not connected — their machine;
//   * somebody answered and did not authenticate — a real problem;
//   * everything is up and they simply have no worktrees.
//
// Collapsing those into "offline" would send somebody to check their wifi
// because a colleague shut a laptop. So each is its own phrase, and the one
// that wins is the one that most needs acting on.
//
// "Connected" has the same problem one layer down. A link is torn down when
// nothing has decrypted for two and a half keepalives, so `connected` is a
// claim with up to five minutes of slack in it, and for those five minutes a
// shut laptop and a working one read identically. A link quiet for longer than
// an ordinary gap between keepalives therefore carries the age of that silence,
// and this says it — `1 connected · last heard 4m ago` — while a link that is
// talking carries nothing and this says nothing new about it.

import type { PeerLink, TeamworkRead, TeamworkStatus } from '@shared/entities'
import { ADD_KEY_BUTTON } from '../teamwork/startTeamwork'
import { sinceLabel } from './agentRows'

/**
 * The label on the button in the project header that opens the setup panel.
 *
 * Shared with the sidebar that renders it, because the tooltip below tells
 * somebody to press it by name: a name written out twice is a name that can
 * end up pointing at a button nobody can find.
 */
export const TEAMWORK_BUTTON_LABEL = 'Teamwork'

export type TeamworkTone =
  /** Everything that can be up is up. */
  | 'live'
  /** In progress, or waiting on somebody else's machine. Not a fault. */
  | 'pending'
  /** Nothing is configured here. A thing to set up. */
  | 'off'
  /** Something is wrong and it is worth reading. */
  | 'problem'

export type TeamworkSummary = {
  tone: TeamworkTone
  /** Short enough for a sidebar header. */
  label: string
  /** The whole of it, for the title attribute. */
  detail: string
}

/**
 * `now` is this machine's clock, and every timestamp below was stamped by the
 * same one — the runtime's, in the same process family, never a teammate's.
 *
 * Passed in rather than read here for the reason `teammateStaleness.ts` takes
 * one: an age is the one number in this sidebar that changes when nothing
 * happens, so the caller that owns the tick owns the clock.
 */
export function teamworkSummary(status: TeamworkStatus | undefined, now: number): TeamworkSummary | null {
  // Not asked yet. An absent answer is not an answer, and rendering one as
  // "off" would be this app claiming something it has not established.
  if (!status) return null

  // Asked, and answered "nothing has been read about this project yet" — the
  // beat after a project is added, and the first moments of a restored session.
  // A row, because a project that has just appeared in this sidebar with no
  // line under it reads as a project teamwork has nothing to say about. But not
  // "off" and not a fault: nothing has been found, so nothing may be named, and
  // the tone is the one that means "in progress, and not yours to fix".
  if (status.state === 'unread') {
    return {
      tone: 'pending',
      label: 'Reading this project',
      detail:
        'teamree has not read this project’s relay, roster or origin yet. Whatever it finds is here in a ' +
        'moment; nothing below has been established until then.'
    }
  }

  if (status.disabledReason !== null) {
    return { tone: 'off', label: 'Teamwork off', detail: status.disabledReason }
  }
  // Before any phase, because every phase below would be a sentence about
  // somebody else's machine. An unenrolled key means each link is parked on a
  // rendezvous the teammate has no key to compute, so they all sit at
  // `waiting` and the header reads "Nobody connected" — pointing at the one
  // machine that is doing nothing wrong.
  if (!status.enrolled) {
    return {
      tone: 'off',
      label: 'Your key is not here',
      detail:
        'Your own key is not in .teamree/members in this checkout, so no teammate can reach you. Open ' +
        `${TEAMWORK_BUTTON_LABEL} in this project’s header and press “${ADD_KEY_BUTTON}”, then commit and push ` +
        'the file it writes.'
    }
  }
  if (status.links.length === 0) {
    return {
      tone: 'off',
      label: 'No teammates',
      detail: 'This project’s roster has nobody in it but you.'
    }
  }

  const counted = (phase: string): number => status.links.filter((link) => link.phase === phase).length
  const refused = status.links.filter((link) => link.phase === 'refused')
  const stopped = status.links.filter((link) => link.phase === 'stopped')
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  const connected = counted('connected')

  // Ordered by what would make somebody look. A failed handshake outranks
  // everything: it is the state most worth reading. It does NOT mean somebody
  // was there and was wrong — this end raising an error before a byte is sent
  // reaches the same phase, so the wording claims only that it failed.
  if (refused.length > 0) {
    return {
      tone: 'problem',
      label: refused.length === 1 ? 'Handshake failed' : `${refused.length} handshakes failed`,
      detail: [
        'Either roster could be the stale one, so pull, and ask them to pull.',
        ...refused.map((link) => `${link.handle}: ${link.detail ?? 'no reason given'}`)
      ].join('\n')
    }
  }
  if (stopped.length > 0) {
    return {
      tone: 'problem',
      label: `${stopped.length} stopped`,
      detail: stopped.map((link) => `${link.handle}: ${link.detail ?? 'this link gave up'}`).join('\n')
    }
  }
  if (unreachable.length > 0 && connected === 0) {
    return {
      tone: 'problem',
      label: 'Relay unreachable',
      detail: `${relayLabel(status)} could not be reached. Your teammates may be fine.`
    }
  }
  if (connected > 0) {
    const away = status.links.length - connected
    // The longest silence among the links that are still up, and only the ones
    // that carry a `lastHeardAt` at all — which a link only does once its
    // silence has outlasted an ordinary gap. A team that is talking adds
    // nothing here, which is the point: "connected" earns its place by being
    // the only thing there is to say.
    const silences = status.links
      .filter((link) => link.phase === 'connected')
      .map((link) => quietFor(link, now))
      .filter((quiet): quiet is number => quiet !== undefined)
    const parts = [`${connected} connected`]
    if (away > 0) parts.push(`${away} away`)
    if (silences.length > 0) parts.push(`last heard ${sinceLabel(Math.max(...silences))} ago`)
    return {
      // Still `live`, because the link is: nothing has failed and nothing has
      // been established about the teammate's machine. What was wrong was the
      // silence being invisible, not the tone it was shown in, and a colour
      // that changed every time somebody's laptop paused for two minutes would
      // be a fault light for something that is not a fault.
      tone: 'live',
      label: parts.join(' · '),
      detail: status.links.map((link) => linkLine(link, now)).join('\n')
    }
  }
  if (counted('waiting') === status.links.length) {
    return {
      tone: 'pending',
      label: 'Nobody connected',
      // Per link underneath, because they do not all say the same thing: a link
      // that has waited across two hourly rendezvous rotations has waited
      // longer than a colleague who stepped out, and what it has to say about
      // that is the only place the clock and the relay file get named.
      detail: [
        `${relayLabel(status)} is reachable. No teammate’s machine is connected to it right now.`,
        ...status.links.filter((link) => link.detail !== undefined).map((link) => `${link.handle}: ${link.detail}`)
      ].join('\n')
    }
  }
  return {
    tone: 'pending',
    label: 'Connecting…',
    detail: status.links.map((link) => linkLine(link, now)).join('\n')
  }
}

/**
 * How long this link has been silent, or nothing when that is not yet a fact.
 *
 * The link decides when it is. `lastHeardAt` is absent until the silence has
 * outlasted `LINK_QUIET_AFTER_MS`, so there is one threshold for this in the
 * whole app and it lives in `peerLink.ts`, beside the keepalive interval it is
 * derived from.
 */
function quietFor(link: PeerLink, now: number): number | undefined {
  return link.lastHeardAt === undefined ? undefined : Math.max(0, now - link.lastHeardAt)
}

/**
 * One link, per line, under the header: what it has to say for itself, and how
 * long it has been since anybody said anything.
 *
 * The detail wins over the phase where there is one, because a link that is
 * connecting *because this machine has just woken up* knows something the word
 * "connecting" does not carry. The age is appended to either, because it is a
 * different fact from the phase and not a substitute for it — a link can be
 * connected and four minutes silent at the same time, which is the whole
 * reason the number is here.
 *
 * Rounded down by `sinceLabel`, as every other age in this sidebar is, so a
 * silence is never flattered: "4m" while the fifth minute runs is the wrong way
 * round for a number whose job is to say nothing has arrived.
 */
function linkLine(link: PeerLink, now: number): string {
  const quiet = quietFor(link, now)
  const head = `${link.handle}: ${link.detail ?? link.phase}`
  return quiet === undefined ? head : `${head}, last heard ${sinceLabel(quiet)} ago`
}

/** Says where the relay came from, because a surprising URL needs a source. */
function relayLabel(status: TeamworkRead): string {
  if (!status.relay) return 'The relay'
  return status.relay.source === 'environment'
    ? `${status.relay.url} (from the environment)`
    : `${status.relay.url} (from .teamree/relay)`
}
