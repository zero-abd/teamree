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

import type { TeamworkStatus } from '@shared/entities'
import { ADD_KEY_BUTTON } from '../dialogs/startTeamwork'

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

export function teamworkSummary(status: TeamworkStatus | undefined): TeamworkSummary | null {
  // Not asked yet. An absent answer is not an answer, and rendering one as
  // "off" would be this app claiming something it has not established.
  if (!status) return null

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
        'Your own key is not in .teamree/members in this checkout, so no teammate can reach you — their ' +
        `machines have nothing to address. Open ${TEAMWORK_BUTTON_LABEL} in this project’s header and press ` +
        `“${ADD_KEY_BUTTON}”, then commit and push the file it writes.`
    }
  }
  if (status.links.length === 0) {
    return {
      tone: 'off',
      label: 'No teammates',
      detail: 'This project’s roster has nobody in it but you, so there is nobody to connect to.'
    }
  }

  const counted = (phase: string): number => status.links.filter((link) => link.phase === phase).length
  const refused = status.links.filter((link) => link.phase === 'refused')
  const stopped = status.links.filter((link) => link.phase === 'stopped')
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  const connected = counted('connected')

  // Ordered by what would make somebody look. A refusal outranks everything:
  // it means somebody was there and was not who they should have been.
  if (refused.length > 0) {
    return {
      tone: 'problem',
      label: `${refused.length} refused`,
      detail: refused.map((link) => `${link.handle}: ${link.detail ?? 'the handshake did not authenticate'}`).join('\n')
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
      detail: `${relayLabel(status)} could not be reached. Teammates may be fine; this machine cannot get to the relay.`
    }
  }
  if (connected > 0) {
    const quiet = status.links.length - connected
    return {
      tone: 'live',
      label: quiet > 0 ? `${connected} connected · ${quiet} away` : `${connected} connected`,
      detail: status.links.map((link) => `${link.handle}: ${link.phase}`).join('\n')
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
    // The phase, and whatever the link has to say for itself — a link that is
    // connecting because this machine has just woken up knows something the
    // word "connecting" does not carry.
    detail: status.links
      .map((link) => (link.detail === undefined ? `${link.handle}: ${link.phase}` : `${link.handle}: ${link.detail}`))
      .join('\n')
  }
}

/** Says where the relay came from, because a surprising URL needs a source. */
function relayLabel(status: TeamworkStatus): string {
  if (!status.relay) return 'The relay'
  return status.relay.source === 'environment'
    ? `${status.relay.url} (from the environment)`
    : `${status.relay.url} (from .teamree/relay)`
}
