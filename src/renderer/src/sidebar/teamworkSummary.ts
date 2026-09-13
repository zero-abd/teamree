// One line about whether teamwork is working, for the project header.
//
// The whole difficulty is that "no teammates on screen" has five causes and
// four of them are not each other:
//
//   * nobody has set a relay up here — a thing to do, not a fault;
//   * the relay cannot be reached — this machine's network, or the relay's;
//   * the relay is fine and the teammate is not connected — their machine;
//   * somebody answered and did not authenticate — a real problem;
//   * everything is up and they simply have no worktrees.
//
// Collapsing those into "offline" would send somebody to check their wifi
// because a colleague shut a laptop. So each is its own phrase, and the one
// that wins is the one that most needs acting on.

import type { TeamworkStatus } from '@shared/entities'

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
      detail: `${relayLabel(status)} is reachable. No teammate’s machine is connected to it right now.`
    }
  }
  return {
    tone: 'pending',
    label: 'Connecting…',
    detail: status.links.map((link) => `${link.handle}: ${link.phase}`).join('\n')
  }
}

/** Says where the relay came from, because a surprising URL needs a source. */
function relayLabel(status: TeamworkStatus): string {
  if (!status.relay) return 'The relay'
  return status.relay.source === 'environment'
    ? `${status.relay.url} (from the environment)`
    : `${status.relay.url} (from .teamree/relay)`
}
