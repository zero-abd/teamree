// One line about whether teamwork is working, for the project header. "No
// teammates on screen" has six causes, each its own phrase; the one that wins
// most needs acting on. `connected` has up to five minutes of slack, so a silent link carries its age.

import type { PeerLink, TeamworkRead, TeamworkStatus } from '@shared/entities'
import { ADD_KEY_BUTTON } from '../teamwork/startTeamwork'
import { agoLabel, sinceLabel } from './agentRows'

/** The word on the header control that opens the setup panel; the tooltip names it, so shared. */
export const TEAMWORK_BUTTON_LABEL = 'Teamwork'

/**
 * What that control reads, with the state folded in: `Teamwork · off`,
 * `Teamwork · 2 connected`, or the bare word before anything has been read.
 */
export function teamworkControlLabel(summary: TeamworkSummary | null): string {
  return summary === null ? TEAMWORK_BUTTON_LABEL : `${TEAMWORK_BUTTON_LABEL} · ${summary.label}`
}

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
  /** The state, short enough to follow "Teamwork" in a header: `off`, `1 connected · 1 away`. */
  label: string
  /** The whole of it, for the title attribute. */
  detail: string
}

/**
 * `now` is this machine's clock, which stamped every timestamp below. Passed
 * in because an age changes when nothing happens: the caller that owns the tick owns the clock.
 */
export function teamworkSummary(status: TeamworkStatus | undefined, now: number): TeamworkSummary | null {
  // Not asked yet; rendering that as "off" would claim something not established.
  if (!status) return null

  // Nothing read yet: the beat after a project is added. A row, but not "off"
  // and not a fault, since nothing has been found and nothing may be named.
  if (status.state === 'unread') {
    return {
      tone: 'pending',
      label: 'reading…',
      detail: 'teamree has not read this project’s relay, roster or origin yet.'
    }
  }

  if (status.disabledReason !== null) {
    return { tone: 'off', label: 'off', detail: status.disabledReason }
  }
  // Before any phase: an unenrolled key parks every link on a rendezvous the
  // teammate cannot compute, and "Nobody connected" would blame the wrong machine.
  if (!status.enrolled) {
    return {
      tone: 'off',
      label: 'no key',
      detail: `Your key is not in .teamree/members here. ${TEAMWORK_BUTTON_LABEL} → “${ADD_KEY_BUTTON}”.`
    }
  }
  if (status.links.length === 0) {
    return {
      tone: 'off',
      label: 'no teammates',
      detail: 'This project’s roster has nobody in it but you.'
    }
  }

  const counted = (phase: string): number => status.links.filter((link) => link.phase === phase).length
  const refused = status.links.filter((link) => link.phase === 'refused')
  const stopped = status.links.filter((link) => link.phase === 'stopped')
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  const connected = counted('connected')

  // A failed handshake outranks everything. It does NOT mean somebody was
  // there and wrong: this end erroring before a byte is sent reaches the same phase.
  if (refused.length > 0) {
    return {
      tone: 'problem',
      label: refused.length === 1 ? 'handshake failed' : `${refused.length} handshakes failed`,
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
      label: 'relay unreachable',
      detail: `${relayLabel(status)} could not be reached.`
    }
  }
  if (connected > 0) {
    const away = status.links.length - connected
    // The longest silence among links still up; a link carries `lastHeardAt`
    // only once its silence has outlasted an ordinary gap.
    const silences = status.links
      .filter((link) => link.phase === 'connected')
      .map((link) => quietFor(link, now))
      .filter((quiet): quiet is number => quiet !== undefined)
    const parts = [`${connected} connected`]
    if (away > 0) parts.push(`${away} away`)
    if (silences.length > 0) parts.push(`silent ${sinceLabel(Math.max(...silences))}`)
    return {
      // Still `live`: nothing has failed, and a colour that changed every time
      // a laptop paused would be a fault light for something that is not a fault.
      tone: 'live',
      label: parts.join(' · '),
      detail: status.links.map((link) => linkLine(link, now)).join('\n')
    }
  }
  if (counted('waiting') === status.links.length) {
    return {
      tone: 'pending',
      label: 'nobody connected',
      // Per link underneath, because they do not all say the same thing.
      detail: [
        `${relayLabel(status)} is reachable. No teammate’s machine is connected to it right now.`,
        ...status.links.filter((link) => link.detail !== undefined).map((link) => `${link.handle}: ${link.detail}`)
      ].join('\n')
    }
  }
  return {
    tone: 'pending',
    label: 'connecting…',
    detail: status.links.map((link) => linkLine(link, now)).join('\n')
  }
}

/**
 * How long this link has been silent, or nothing until `lastHeardAt` appears:
 * the one threshold is `LINK_QUIET_AFTER_MS` in `peerLink.ts`.
 */
function quietFor(link: PeerLink, now: number): number | undefined {
  return link.lastHeardAt === undefined ? undefined : Math.max(0, now - link.lastHeardAt)
}

/**
 * One link per line under the header. The detail wins over the phase where
 * there is one; the age is appended to either, since a link can be connected and four minutes silent.
 */
function linkLine(link: PeerLink, now: number): string {
  const quiet = quietFor(link, now)
  const head = `${link.handle}: ${link.detail ?? link.phase}`
  return quiet === undefined ? head : `${head}, last heard ${agoLabel(quiet)}`
}

/** Says where the relay came from, because a surprising URL needs a source. */
function relayLabel(status: TeamworkRead): string {
  if (!status.relay) return 'The relay'
  return status.relay.source === 'environment'
    ? `${status.relay.url} (from the environment)`
    : `${status.relay.url} (from .teamree/relay)`
}
